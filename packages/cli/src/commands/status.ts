/**
 * `pulserun status <job_id>` — read and display on-chain job state.
 *
 * The command only performs a read-only simulation, so it works without a
 * signing key.
 */

import { type Command } from 'commander';
import {
  type JobJson,
  type JobRecord,
  PulseRunClient,
  PulseRunError,
  isTerminalStatus,
  jobToJson,
  stroopsToXlm,
  toJobId,
} from '../client/soroban.js';
import { resolveConnection } from '../config.js';
import {
  type Logger,
  createLogger,
  formatDuration,
  formatTimestamp,
  shortenAddress,
} from '../ui.js';
import { emitJson } from './run.js';

export interface StatusOptions {
  network?: string;
  rpcUrl?: string;
  contract?: string;
  key?: string;
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

/** Human-readable, aligned rendering of a job record. */
export function formatJob(job: JobRecord, nowSeconds: number): string {
  const remaining = job.deadline - nowSeconds;
  const remainingLabel =
    remaining >= 0 ? `${formatDuration(remaining)} left` : `${formatDuration(-remaining)} ago`;

  const rows: Array<[string, string]> = [
    ['Status', job.status],
    ['Client', shortenAddress(job.client)],
    ['Runner', shortenAddress(job.runner)],
    ['Image', job.image],
    ['Command', job.command],
    ['Budget', `${stroopsToXlm(job.maxBudgetStroops)} XLM`],
    ['Created', formatTimestamp(job.createdAt)],
    ['Deadline', `${formatTimestamp(job.deadline)} (${remainingLabel})`],
    ['Output hash', job.outputHash ?? '—'],
    ['Exit code', job.exitCode === null ? '—' : String(job.exitCode)],
  ];

  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  const header = `Job #${job.id}`;
  return [header, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join('\n');
}

/**
 * Reads a job and renders it.
 *
 * @throws {PulseRunError} when the job id is malformed or the read fails.
 */
export async function statusCommand(
  jobId: string | number | bigint,
  options: StatusOptions = {},
  deps: StatusDependencies = {},
): Promise<JobJson> {
  const logger = deps.logger ?? createLogger();
  const stdout = deps.stdout ?? process.stdout;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

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
  const nowSeconds = now();

  if (options.json) {
    const json = jobToJson(job, nowSeconds);
    emitJson(stdout, json);
    return json;
  }

  logger.info(formatJob(job, nowSeconds));

  if (!isTerminalStatus(job.status)) {
    logger.info(
      `Still ${job.status.toLowerCase()}; the runner has ${formatDuration(job.deadline - nowSeconds)} to submit a proof.`,
    );
  } else if (job.status !== 'Completed') {
    logger.warn(`Job #${job.id} finished as ${job.status}.`);
  }

  return jobToJson(job, nowSeconds);
}

/** Registers the `status` subcommand on the root program. */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show on-chain status, time remaining and output hash for a job.')
    .argument('<job_id>', 'on-chain job id')
    .option('--network <name>', 'testnet | futurenet | mainnet | local')
    .option('--rpc-url <url>', 'Soroban RPC endpoint override')
    .option('--contract <id>', 'PulseRun escrow contract ID (C...)')
    .option('--key <secret>', 'optional Stellar secret key used as the RPC source account')
    .option('--json', 'emit machine-readable JSON')
    .action(async (rawJobId: string, options: StatusOptions) => {
      if (!rawJobId?.trim()) {
        throw new PulseRunError('Missing job id: usage `pulserun status <job_id>`.');
      }
      await statusCommand(rawJobId, options);
    });
}
