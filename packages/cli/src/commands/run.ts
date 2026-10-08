/**
 * `pulserun run` — open a pay-per-run escrow on the PulseRun contract.
 *
 * The CLI does not talk to a runner directly. It locks `max_budget` base units
 * of the payment token in the `PulseEscrow` contract via `create_job` and then
 * watches `get_job` until a runner submits an execution proof and the escrow
 * settles (or refunds).
 *
 * The contract deliberately does not carry the job's command line — pulserun-core
 * tracks an on-chain metadata hash as planned work. Until that lands, a
 * requester can record the job's image and command in a local spec file with
 * `--spec-out`, which a co-located runner daemon reads. See the README.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { type Command } from 'commander';
import {
  type ComputeJob,
  DEFAULT_POLL_INTERVAL_MS,
  PulseRunClient,
  PulseRunError,
  formatTokenAmount,
  isTerminalStatus,
  parseTokenAmount,
} from '../client/soroban.js';
import {
  parseDecimals,
  parsePositiveMs,
  parsePositiveSeconds,
  resolveConnection,
  resolvePaymentToken,
  resolveSecretKey,
} from '../config.js';
import { createLogger, formatDuration, shortenAddress, type Logger } from '../ui.js';

/** Default upper bound on billable seconds when `--max-duration` is omitted. */
export const DEFAULT_MAX_DURATION_SECONDS = 3_600;

export interface RunOptions {
  /** Runner address allowed to execute the job and submit the proof. */
  runner: string;
  /** Escrowed ceiling, in whole token units. */
  maxBudget: string;
  /** Linear price per executed second, in whole token units. */
  rate: string;
  /** Upper bound on billable seconds. */
  maxDuration?: string;
  /** Payment token contract ID; falls back to `MOCKTOKEN_ID`/`PAYMENT_TOKEN_ID`. */
  token?: string;
  /** Token decimal precision; defaults to 7. */
  decimals?: string;
  /** Image recorded in the local job spec (not stored on-chain). */
  image?: string;
  /** Command recorded in the local job spec (not stored on-chain). */
  cmd?: string;
  /** Appends the job spec for this job to a local JSON file. */
  specOut?: string;
  /** Stellar secret key used to sign `create_job`. */
  key?: string;
  network?: string;
  rpcUrl?: string;
  contract?: string;
  /** Delay between on-chain polls, in milliseconds. */
  pollInterval?: string;
  /** `--no-wait` returns as soon as the job is escrowed. */
  wait?: boolean;
  /** Emit machine-readable output instead of the human summary. */
  json?: boolean;
}

export interface RunDependencies {
  logger?: Logger;
  /** Overrides the client, used by tests to avoid network access. */
  client?: PulseRunClient;
  stdout?: NodeJS.WritableStream;
}

export interface RunResult {
  submission: { jobId: bigint; txHash: string; ledger: number };
  /** `null` when `--no-wait` was passed. */
  job: ComputeJob | null;
}

const JSON_INDENT = 2;

/** `JSON.stringify` replacer that renders bigints as decimal strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Writes `value` as indented JSON to `stream`, flushing a trailing newline. */
export function emitJson(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, jsonReplacer, JSON_INDENT)}\n`);
}

/** Projects a {@link ComputeJob} into JSON-friendly output. */
export function jobToJson(job: ComputeJob, decimals = 7) {
  return {
    jobId: job.jobId.toString(),
    requester: job.requester,
    runner: job.runner,
    paymentToken: job.paymentToken,
    maxBudget: job.maxBudget.toString(),
    maxBudgetTokens: formatTokenAmount(job.maxBudget, decimals),
    ratePerSecond: job.ratePerSecond.toString(),
    ratePerSecondTokens: formatTokenAmount(job.ratePerSecond, decimals),
    maxDurationSecs: job.maxDurationSecs,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    outputHash: job.outputHash,
  };
}

/**
 * Runs a job end to end: resolve config, open the escrow and (unless disabled)
 * poll until the job reaches a terminal state.
 *
 * @throws {PulseRunError} on invalid input or when the on-chain call fails.
 */
export async function runCommand(
  options: RunOptions,
  deps: RunDependencies = {},
): Promise<RunResult> {
  const logger = deps.logger ?? createLogger();
  const stdout = deps.stdout ?? process.stdout;

  const runner = (options.runner ?? '').trim();
  if (!runner) {
    throw new PulseRunError('Missing --runner: provide the address allowed to execute the job.');
  }

  const decimals = parseDecimals(options.decimals);
  const connection = resolveConnection(options);
  const secret = resolveSecretKey(options);
  const paymentToken = resolvePaymentToken(options);
  const maxDurationSecs = parsePositiveSeconds(
    options.maxDuration,
    'max-duration',
    DEFAULT_MAX_DURATION_SECONDS,
  );
  const pollIntervalMs = parsePositiveMs(
    options.pollInterval,
    'poll-interval',
    DEFAULT_POLL_INTERVAL_MS,
  );

  // Validate the amounts before we hit the network so typos fail fast.
  const maxBudget = parseTokenAmount(options.maxBudget, decimals);
  const ratePerSecond = parseTokenAmount(options.rate, decimals);

  const client =
    deps.client ??
    PulseRunClient.fromSecretKey(secret, {
      rpcUrl: connection.rpcUrl,
      networkPassphrase: connection.networkPassphrase,
      contractId: connection.contractId,
      pollIntervalMs,
    });

  if (!options.json) {
    logger.info(
      `Opening escrow on ${connection.network} (${shortenAddress(connection.contractId)})`,
    );
    logger.info(`  Runner        ${shortenAddress(runner)}`);
    logger.info(`  Payment token ${shortenAddress(paymentToken)}`);
    logger.info(`  Max budget    ${formatTokenAmount(maxBudget, decimals)} (base units)`);
    logger.info(`  Rate/second   ${formatTokenAmount(ratePerSecond, decimals)}`);
    logger.info(`  Max duration  ${formatDuration(maxDurationSecs)}`);
  }

  const submission = await client.createJob({
    runner,
    paymentToken,
    maxBudget,
    ratePerSecond,
    maxDurationSecs,
  });

  if (!options.json) {
    logger.success(
      `Job #${submission.jobId} escrowed (tx ${submission.txHash}, ledger ${submission.ledger}).`,
    );
  }

  await maybeWriteSpec(options, submission.jobId);

  if (options.wait === false) {
    if (options.json) {
      emitJson(stdout, {
        jobId: submission.jobId.toString(),
        txHash: submission.txHash,
        ledger: submission.ledger,
        job: null,
      });
    }
    return { submission, job: null };
  }

  if (!options.json) {
    logger.info(`Watching job #${submission.jobId} (Ctrl-C leaves the escrow open on-chain)…`);
  }

  // Wait long enough for the runner to prove and the dispute window to elapse,
  // plus a margin so the final transition is observable.
  let disputeWindowSecs = 0;
  try {
    disputeWindowSecs = await client.getDisputeWindow();
  } catch {
    // The window is only needed to size the poll budget; fall back to the job's
    // own duration if the view is unavailable.
  }
  const timeoutMs = (maxDurationSecs + disputeWindowSecs + 120) * 1000;

  let lastStatus = '';
  const job = await client.waitForJob(submission.jobId, {
    timeoutMs,
    onPoll: (polled) => {
      if (options.json || polled.status === lastStatus) return;
      lastStatus = polled.status;
      logger.info(`  → ${polled.status}`);
    },
  });

  if (options.json) {
    emitJson(stdout, {
      jobId: submission.jobId.toString(),
      txHash: submission.txHash,
      ledger: submission.ledger,
      job: jobToJson(job, decimals),
    });
  } else {
    printJobSummary(logger, job, decimals);
  }

  return { submission, job };
}

/** Records the job's image/command in a local spec file, when requested. */
async function maybeWriteSpec(options: RunOptions, jobId: bigint): Promise<void> {
  const path = options.specOut?.trim();
  if (!path) return;
  const image = (options.image ?? '').trim();
  const command = (options.cmd ?? '').trim();
  if (!image || !command) {
    throw new PulseRunError('--spec-out requires both --image and --cmd.');
  }

  let specs: Record<string, { image: string; command: string }> = {};
  try {
    specs = JSON.parse(await readFile(path, 'utf8')) as typeof specs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PulseRunError(`Could not read job spec file "${path}".`, { cause: error });
    }
  }
  specs[jobId.toString()] = { image, command };
  await writeFile(path, `${JSON.stringify(specs, null, JSON_INDENT)}\n`, 'utf8');
}

/** Renders the post-execution summary shown by `pulserun run`. */
export function printJobSummary(logger: Logger, job: ComputeJob, decimals = 7): void {
  const lines = [
    `  Status        ${job.status}`,
    `  Budget        ${formatTokenAmount(job.maxBudget, decimals)} (base units)`,
    `  Output hash   ${job.outputHash}`,
    `  Completed at  ${job.completedAt === 0 ? '—' : job.completedAt}`,
  ];
  if (isTerminalStatus(job.status)) {
    const headline =
      job.status === 'Settled'
        ? `Job #${job.jobId} settled.`
        : `Job #${job.jobId} ${job.status.toLowerCase()}.`;
    (job.status === 'Settled' ? logger.success : logger.warn)(headline);
  } else {
    logger.info(`Job #${job.jobId} is still ${job.status.toLowerCase()}.`);
  }
  for (const line of lines) logger.info(line);
}

/**
 * Process exit code for a finished `run`: non-zero unless the escrow settled,
 * so CI pipelines can gate on `pulserun run`.
 */
export function runExitCode(result: RunResult): number {
  if (!result.job) return 0;
  return result.job.status === 'Settled' ? 0 : 1;
}

/** Registers the `run` subcommand on the root program. */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Lock a budget in escrow for a runner to execute a job.')
    .requiredOption('--runner <address>', 'runner address allowed to execute the job')
    .requiredOption('--max-budget <amount>', 'maximum budget to lock in escrow, in token units')
    .requiredOption('--rate <amount>', 'price per executed second, in token units')
    .option(
      '--max-duration <seconds>',
      'upper bound on billable seconds',
      String(DEFAULT_MAX_DURATION_SECONDS),
    )
    .option('--token <id>', 'payment token contract ID (C...)')
    .option('--decimals <n>', 'payment token decimal precision', '7')
    .option('--image <image>', 'image recorded in the local job spec')
    .option('--cmd <command>', 'command recorded in the local job spec')
    .option('--spec-out <file>', 'append the job spec to a local JSON file')
    .option('--key <secret>', 'Stellar secret key (S...) used to sign create_job')
    .option('--poll-interval <ms>', 'delay between status polls in milliseconds')
    .option('--network <name>', 'testnet | futurenet | mainnet | local')
    .option('--rpc-url <url>', 'Soroban RPC endpoint override')
    .option('--contract <id>', 'PulseEscrow contract ID (C...)')
    .option('--no-wait', 'return as soon as the job is escrowed')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: RunOptions) => {
      const result = await runCommand(options);
      process.exitCode = runExitCode(result);
    });
}
