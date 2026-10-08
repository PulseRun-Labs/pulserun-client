/**
 * `pulserun status <job_id>` — read and display on-chain job state.
 *
 * The command only performs read-only simulations, so it works without a
 * signing key.
 */

import { type Command } from 'commander';
import {
  type ComputeJob,
  type ExecutionProofRecord,
  PulseRunClient,
  isTerminalStatus,
  formatTokenAmount,
  toJobId,
} from '../client/soroban.js';
import { parseDecimals, resolveConnection } from '../config.js';
import {
  type Logger,
  createLogger,
  formatDuration,
  formatTimestamp,
  shortenAddress,
} from '../ui.js';
import { emitJson, jobToJson } from './run.js';

export interface StatusOptions {
  network?: string;
  rpcUrl?: string;
  contract?: string;
  key?: string;
  decimals?: string;
  json?: boolean;
}

export interface StatusDependencies {
  logger?: Logger;
  /** Overrides the client, used by tests to avoid network access. */
  client?: PulseRunClient;
  stdout?: NodeJS.WritableStream;
  /** Overrides "now", used by tests to keep durations deterministic. */
  now?: () => number;
}

/** Human-readable, aligned rendering of a job record plus its proof. */
export function formatJob(
  job: ComputeJob,
  proof: ExecutionProofRecord | null,
  nowSeconds: number,
  decimals = 7,
): string {
  const rows: Array<[string, string]> = [
    ['Status', job.status],
    ['Requester', shortenAddress(job.requester)],
    ['Runner', shortenAddress(job.runner)],
    ['Payment token', shortenAddress(job.paymentToken)],
    ['Max budget', `${formatTokenAmount(job.maxBudget, decimals)} (base units)`],
    ['Rate / second', formatTokenAmount(job.ratePerSecond, decimals)],
    ['Max duration', formatDuration(job.maxDurationSecs)],
    ['Created', formatTimestamp(job.createdAt)],
    [
      'Expires',
      job.status === 'Queued'
        ? `${formatTimestamp(job.createdAt + job.maxDurationSecs)} (${formatDuration(
            job.createdAt + job.maxDurationSecs - nowSeconds,
          )} ${job.createdAt + job.maxDurationSecs - nowSeconds >= 0 ? 'left' : 'ago'})`
        : '—',
    ],
    ['Completed', job.completedAt === 0 ? '—' : formatTimestamp(job.completedAt)],
    ['Output hash', job.outputHash],
  ];
  if (proof) {
    rows.push(['Proof duration', `${proof.durationSecs}s`]);
    rows.push(['Exit code', String(proof.exitCode)]);
  }

  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  const header = `Job #${job.jobId}`;
  return [header, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join('\n');
}

/**
 * Reads a job (and its proof) and renders it.
 *
 * @throws {PulseRunError} when the job id is malformed or the read fails.
 */
export async function statusCommand(
  jobId: string | number | bigint,
  options: StatusOptions = {},
  deps: StatusDependencies = {},
): Promise<ComputeJob> {
  const logger = deps.logger ?? createLogger();
  const stdout = deps.stdout ?? process.stdout;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const decimals = parseDecimals(options.decimals);

  const id = toJobId(jobId);
  const connection = resolveConnection(options);
  const endpoints = {
    rpcUrl: connection.rpcUrl,
    networkPassphrase: connection.networkPassphrase,
    contractId: connection.contractId,
  };
  const client =
    deps.client ??
    (options.key
      ? PulseRunClient.fromSecretKey(options.key, endpoints)
      : new PulseRunClient(endpoints));

  const job = await client.getJob(id);
  const proof = await client.getProof(id);
  const nowSeconds = now();

  if (options.json) {
    emitJson(stdout, {
      job: jobToJson(job, decimals),
      proof: proof ? { ...proof, jobId: proof.jobId.toString() } : null,
    });
    return job;
  }

  logger.info(formatJob(job, proof, nowSeconds, decimals));

  if (!isTerminalStatus(job.status)) {
    logger.info(`Job #${job.jobId} is ${job.status.toLowerCase()}; no payout is final yet.`);
  } else if (job.status === 'Refunded') {
    logger.warn(`Job #${job.jobId} was refunded to the requester.`);
  }

  return job;
}

/** Registers the `status` subcommand on the root program. */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show on-chain status, timing and output hash for a job.')
    .argument('<job_id>', 'on-chain job id')
    .option('--network <name>', 'testnet | futurenet | mainnet | local')
    .option('--rpc-url <url>', 'Soroban RPC endpoint override')
    .option('--contract <id>', 'PulseEscrow contract ID (C...)')
    .option('--key <secret>', 'optional Stellar secret key used as the RPC source account')
    .option('--decimals <n>', 'payment token decimal precision', '7')
    .option('--json', 'emit machine-readable JSON')
    .action(async (rawJobId: string, options: StatusOptions) => {
      await statusCommand(rawJobId, options);
    });
}
