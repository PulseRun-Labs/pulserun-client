/**
 * `pulserun run` — submit a compute job to the PulseRun escrow contract.
 *
 * The CLI does not talk to a runner directly. It locks `max_budget` XLM in the
 * Soroban escrow contract via `create_job` and then watches `get_job` until a
 * runner daemon submits an execution proof.
 */

import { type Command } from 'commander';
import {
  DEFAULT_JOB_TIMEOUT_SECONDS,
  DEFAULT_POLL_INTERVAL_MS,
  type JobRecord,
  type JobSubmission,
  PulseRunClient,
  PulseRunError,
  isTerminalStatus,
  jobToJson,
  stroopsToXlm,
  xlmToStroops,
} from '../client/soroban.js';
import {
  parsePositiveMs,
  parsePositiveSeconds,
  resolveConnection,
  resolveSecretKey,
} from '../config.js';
import { createLogger, formatDuration, shortenAddress, type Logger } from '../ui.js';

export interface RunOptions {
  /** Docker image the runner must execute. */
  image: string;
  /** Shell command executed inside the container. */
  cmd: string;
  /** Escrowed budget, in XLM. */
  maxBudget: string;
  /** Stellar secret key used to sign `create_job`. */
  key?: string;
  /** Runner address allowed to execute the job; defaults to the signer. */
  runner?: string;
  network?: string;
  rpcUrl?: string;
  contract?: string;
  /** Job deadline, in seconds from now. */
  timeout?: string;
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
  submission: JobSubmission;
  /** `null` when `--no-wait` was passed. */
  job: JobRecord | null;
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

/**
 * Runs a job end to end: resolve config, lock the escrow and (unless disabled)
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

  const image = (options.image ?? '').trim();
  const command = (options.cmd ?? '').trim();
  if (!image) {
    throw new PulseRunError('Missing --image: provide the Docker image the runner should execute.');
  }
  if (!command) {
    throw new PulseRunError('Missing --cmd: provide the command to run inside the container.');
  }

  const connection = resolveConnection(options);
  const secret = resolveSecretKey(options);
  const timeoutSeconds = parsePositiveSeconds(
    options.timeout,
    'timeout',
    DEFAULT_JOB_TIMEOUT_SECONDS,
  );
  const pollIntervalMs = parsePositiveMs(
    options.pollInterval,
    'poll-interval',
    DEFAULT_POLL_INTERVAL_MS,
  );
  // Validate the budget before we hit the network so typos fail fast.
  const maxBudgetStroops = xlmToStroops(options.maxBudget);

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
      `Submitting job to ${connection.network} (${shortenAddress(connection.contractId)})`,
    );
    logger.info(`  Image      ${image}`);
    logger.info(`  Command    ${command}`);
    logger.info(`  Budget     ${stroopsToXlm(maxBudgetStroops)} XLM`);
    logger.info(`  Timeout    ${formatDuration(timeoutSeconds)}`);
    if (options.runner) logger.info(`  Runner     ${options.runner}`);
  }

  const submission = await client.createJob({
    image,
    command,
    maxBudgetXlm: options.maxBudget,
    runner: options.runner,
    timeoutSeconds,
  });

  if (!options.json) {
    logger.success(
      `Job #${submission.jobId} escrowed (tx ${submission.txHash}, ledger ${submission.ledger}).`,
    );
  }

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
    logger.info(`Watching job #${submission.jobId} (Ctrl-C leaves the job running on-chain)…`);
  }

  let lastStatus = '';
  const job = await client.waitForJob(submission.jobId, {
    // Leave a small margin on top of the on-chain deadline so the final
    // `Failed`/`Expired` transition is still observable.
    timeoutMs: (timeoutSeconds + 60) * 1000,
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
      job: jobToJson(job, Math.floor(Date.now() / 1000)),
    });
  } else {
    printJobSummary(logger, job);
  }

  return { submission, job };
}

/** Renders the post-execution summary shown by `pulserun run`. */
export function printJobSummary(logger: Logger, job: JobRecord, nowSeconds = nowInSeconds()): void {
  const remaining = job.deadline - nowSeconds;
  const lines = [
    `  Status      ${job.status}`,
    `  Exit code   ${job.exitCode ?? '—'}`,
    `  Output hash ${job.outputHash ?? '—'}`,
    `  Deadline    ${formatDuration(remaining)} ${remaining >= 0 ? 'left' : 'ago'}`,
  ];
  if (isTerminalStatus(job.status)) {
    const headline =
      job.status === 'Completed'
        ? `Job #${job.id} completed.`
        : `Job #${job.id} ${job.status.toLowerCase()}.`;
    (job.status === 'Completed' ? logger.success : logger.warn)(headline);
  } else {
    logger.info(`Job #${job.id} is still ${job.status.toLowerCase()}.`);
  }
  for (const line of lines) logger.info(line);
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Process exit code for a finished `run`: non-zero when the job did not
 * complete, so CI pipelines can gate on `pulserun run`.
 */
export function runExitCode(result: RunResult): number {
  if (!result.job) return 0;
  return result.job.status === 'Completed' ? 0 : 1;
}

/** Registers the `run` subcommand on the root program. */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Lock a budget in escrow and execute a Docker image on a PulseRun runner.')
    .requiredOption('--image <image>', 'Docker image the runner should execute')
    .requiredOption('--cmd <command>', 'command to run inside the container')
    .requiredOption('--max-budget <xlm>', 'maximum budget to lock in escrow, in XLM')
    .option('--key <secret>', 'Stellar secret key (S...) used to sign create_job')
    .option('--runner <address>', 'runner address allowed to execute the job')
    .option(
      '--timeout <seconds>',
      'job deadline in seconds from now',
      String(DEFAULT_JOB_TIMEOUT_SECONDS),
    )
    .option('--poll-interval <ms>', 'delay between status polls in milliseconds')
    .option('--network <name>', 'testnet | futurenet | mainnet | local')
    .option('--rpc-url <url>', 'Soroban RPC endpoint override')
    .option('--contract <id>', 'PulseRun escrow contract ID (C...)')
    .option('--no-wait', 'return as soon as the job is escrowed')
    .option('--json', 'emit machine-readable JSON')
    .action(async (options: RunOptions) => {
      const result = await runCommand(options);
      process.exitCode = runExitCode(result);
    });
}
