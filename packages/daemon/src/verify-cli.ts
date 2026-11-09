#!/usr/bin/env node
/**
 * `pulserun-verify` entrypoint.
 *
 * Re-runs a proved job and compares the digest it produces with the one the
 * runner committed on-chain. This is the third role in the protocol: a
 * requester, a runner and anyone who wants to check the runner's work. It is
 * read-only — no Stellar secret key is required, only Soroban RPC and Docker.
 *
 * Exit codes:
 *
 * - `0` — the re-run reproduced the on-chain output hash and exit code.
 * - `1` — the re-run produced a different result.
 * - `2` — verification could not run (no proof, bad spec, Docker or RPC error).
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DaemonError, type Logger, createLogger, loadVerifierConfig } from './config.js';
import { RunnerEscrow } from './contract.js';
import { DockerExecutor, createDockerRuntime } from './executor.js';
import { FileJobSpecStore, type JobSpec, verifyJobSpecSignature } from './specs.js';
import {
  type VerificationResult,
  formatVerification,
  verificationExitCode,
  verificationToJson,
  verifyExecution,
} from './verify.js';

/** Version reported by `pulserun-verify --version`. Keep in sync with package.json. */
export const VERIFIER_VERSION = '0.3.0';

export const USAGE = `pulserun-verify ${VERIFIER_VERSION}
Re-runs a proved job and compares the result with the on-chain proof.

Usage: pulserun-verify <job_id> [options]

Options:
  --specs <file>      job spec file (defaults to PULSERUN_JOB_SPECS_FILE)
  --image <image>     reproduce with this image instead of the signed spec
  --cmd <command>     reproduce with this command (requires --image)
  --network <name>    testnet | futurenet | mainnet | local
  --rpc-url <url>     Soroban RPC endpoint override
  --contract <id>     PulseEscrow contract ID (C...)
  --json              emit machine-readable JSON
  -h, --help          show this help
  -v, --version       print the verifier version

Reads PULSEESCROW_ID, PULSERUN_NETWORK, STELLAR_RPC_URL and the sandbox limit
variables from the environment. No secret key is needed or read.

Exit codes: 0 verified, 1 not reproduced, 2 could not verify.`;

const FLAG_TO_FIELD = {
  '--specs': 'specs',
  '--image': 'image',
  '--cmd': 'cmd',
  '--network': 'network',
  '--rpc-url': 'rpcUrl',
  '--contract': 'contract',
} as const;

type ValueField = (typeof FLAG_TO_FIELD)[keyof typeof FLAG_TO_FIELD];

export interface VerifyArgs {
  jobId?: string;
  specs?: string;
  image?: string;
  cmd?: string;
  network?: string;
  rpcUrl?: string;
  contract?: string;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Parses verifier flags: one positional job id plus the documented options. */
export function parseVerifyArgs(argv: readonly string[]): VerifyArgs {
  const args: VerifyArgs = { json: false, help: false, version: false };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === undefined) continue;

    if (raw === '-h' || raw === '--help') {
      args.help = true;
      continue;
    }
    if (raw === '-v' || raw === '--version') {
      args.version = true;
      continue;
    }
    if (raw === '--json') {
      args.json = true;
      continue;
    }
    if (!raw.startsWith('-')) {
      positionals.push(raw);
      continue;
    }

    const [flag = '', inline] = raw.split('=', 2);
    const field = FLAG_TO_FIELD[flag as keyof typeof FLAG_TO_FIELD] as ValueField | undefined;
    if (!field) {
      throw new DaemonError(`Unknown argument "${raw}". Run "pulserun-verify --help" for usage.`);
    }

    const value = inline ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new DaemonError(`${flag} requires a value.`);
    }
    if (inline === undefined) index += 1;
    args[field] = value;
  }

  if (positionals.length > 1) {
    throw new DaemonError(
      `Expected one job id, received ${positionals.length}: ${positionals.join(', ')}.`,
    );
  }
  if (positionals[0] !== undefined) args.jobId = positionals[0];
  return args;
}

/** Normalises a user-supplied job id into a `u64`-safe bigint. */
export function parseJobId(value: string): bigint {
  const text = value.trim().replace(/^#/, '');
  if (!/^\d+$/.test(text)) {
    throw new DaemonError(`Invalid job id "${value}": expected a non-negative integer.`);
  }
  return BigInt(text);
}

export interface VerifyDependencies {
  logger?: Logger;
  escrow?: Pick<RunnerEscrow, 'getJob' | 'getProof'>;
  executor?: Pick<DockerExecutor, 'execute'>;
  stdout?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

export interface VerifyOutcome {
  result: VerificationResult;
  spec: JobSpec;
  /** False when the spec came from `--image/--cmd` rather than a signature. */
  signatureChecked: boolean;
}

function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Loads the proof and spec, re-runs the job and compares the results.
 *
 * @throws {DaemonError} when verification cannot run at all.
 */
export async function verifyCommand(
  args: VerifyArgs,
  deps: VerifyDependencies = {},
): Promise<VerifyOutcome> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? createLogger();
  const stdout = deps.stdout ?? process.stdout;

  if (!args.jobId) {
    throw new DaemonError('Missing <job_id>. Run "pulserun-verify --help" for usage.');
  }
  const jobId = parseJobId(args.jobId);

  // Flags win over the environment, matching the CLI's precedence.
  const effectiveEnv: NodeJS.ProcessEnv = { ...env };
  if (args.contract) effectiveEnv.PULSEESCROW_ID = args.contract;
  if (args.network) effectiveEnv.PULSERUN_NETWORK = args.network;
  if (args.rpcUrl) effectiveEnv.STELLAR_RPC_URL = args.rpcUrl;

  const config = loadVerifierConfig(effectiveEnv);
  const escrow =
    deps.escrow ??
    new RunnerEscrow({
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      contractId: config.contractId,
    });

  const job = await escrow.getJob(jobId);
  const proof = await escrow.getProof(jobId);
  if (!proof) {
    throw new DaemonError(`Job #${jobId} has no proof on-chain yet; there is nothing to verify.`);
  }

  const { spec, signatureChecked } = await resolveSpec(
    args,
    job.jobId,
    job.requester,
    config,
    logger,
  );

  const timeoutSeconds = Math.max(1, Math.min(job.maxDurationSecs, config.jobTimeoutSeconds));
  const executor =
    deps.executor ??
    new DockerExecutor({
      runtime: createDockerRuntime({ dockerHost: config.dockerHost }),
      logger,
      limits: config.limits,
    });

  const result = await verifyExecution({ job, proof, spec, timeoutSeconds }, { executor });

  if (args.json) {
    stdout.write(`${JSON.stringify(verificationToJson(result), null, 2)}\n`);
  } else {
    logger.info(`Job #${job.jobId} verification`);
    logger.info(`  Spec          ${spec.image} — ${spec.command}`);
    logger.info(
      `  Authorized by ${
        signatureChecked
          ? `${shortenAddress(job.requester)} (signature checked)`
          : 'operator flags (no signature to check)'
      }`,
    );
    logger.info(formatVerification(result));
  }

  return { result, spec, signatureChecked };
}

/** Resolves the image/command, enforcing the requester's signature by default. */
async function resolveSpec(
  args: VerifyArgs,
  jobId: bigint,
  requester: string,
  config: ReturnType<typeof loadVerifierConfig>,
  logger: Logger,
): Promise<{ spec: JobSpec; signatureChecked: boolean }> {
  const image = (args.image ?? '').trim();
  const command = (args.cmd ?? '').trim();

  if (image || command) {
    if (!image || !command) {
      throw new DaemonError('--image and --cmd must be provided together.');
    }
    logger.warn(
      'Reproducing from --image/--cmd: the command is not checked against the requester signature.',
    );
    return { spec: { image, command }, signatureChecked: false };
  }

  const path = (args.specs ?? config.jobSpecsFile).trim();
  const spec = await new FileJobSpecStore({ path, logger }).get(jobId);
  if (!spec) {
    throw new DaemonError(
      `No spec for job #${jobId} in ${path}. Pass --image and --cmd to reproduce it manually.`,
    );
  }
  if (!verifyJobSpecSignature({ jobId, requester }, spec)) {
    throw new DaemonError(
      `The spec for job #${jobId} is not signed by requester ${requester}; refusing to run it.`,
    );
  }
  return { spec, signatureChecked: true };
}

export interface VerifyMainOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  stdout?: NodeJS.WritableStream;
  escrow?: Pick<RunnerEscrow, 'getJob' | 'getProof'>;
  executor?: Pick<DockerExecutor, 'execute'>;
}

/** CLI entrypoint: parse flags, verify, and map the verdict to an exit code. */
export async function main(options: VerifyMainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;

  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(argv);
  } catch (error) {
    createLogger({ level: 'error' }).error(messageOf(error));
    return 2;
  }

  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.version) {
    stdout.write(`${VERIFIER_VERSION}\n`);
    return 0;
  }
  if (!args.jobId) {
    createLogger({ level: 'error' }).error(
      'pulserun-verify: missing <job_id>. Run "pulserun-verify --help" for usage.',
    );
    return 2;
  }

  const logger = options.logger ?? createLogger();
  try {
    const outcome = await verifyCommand(args, {
      logger,
      stdout,
      ...(options.env ? { env: options.env } : {}),
      ...(options.escrow ? { escrow: options.escrow } : {}),
      ...(options.executor ? { executor: options.executor } : {}),
    });
    return verificationExitCode(outcome.result);
  } catch (error) {
    logger.error(`pulserun-verify: ${messageOf(error)}`);
    return 2;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when this module is the process entrypoint (follows `bin` symlinks). */
export function isDirectExecution(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
