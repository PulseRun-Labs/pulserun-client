#!/usr/bin/env node
/**
 * `pulserun-daemon` entrypoint.
 *
 * Wires the three daemon responsibilities together:
 *
 * 1. {@link JobWatcher} polls Soroban RPC for `job_created` events addressed to
 *    this runner.
 * 2. {@link DockerExecutor} runs each job in a resource-limited sandbox.
 * 3. {@link SorobanProofSubmitter} hashes the output and calls `submit_proof`
 *    so the escrow can settle.
 */

import { rpc } from '@stellar/stellar-sdk';
import { DaemonError, type DaemonConfig, type Logger, createLogger, loadConfig } from './config.js';
import {
  type ContainerRuntime,
  type ExecutionRequest,
  type ExecutionResult,
  DockerExecutor,
  createDockerRuntime,
} from './executor.js';
import {
  type ExecutionProof,
  type ProofSubmitter,
  SorobanProofSubmitter,
  buildProof,
  formatProof,
} from './proof.js';
import { type JobCreatedEvent, JobWatcher } from './watcher.js';

/** Version reported by `pulserun-daemon --version`. Keep in sync with package.json. */
export const DAEMON_VERSION = '0.1.0';

export const USAGE = `pulserun-daemon ${DAEMON_VERSION}
Watches the PulseRun escrow contract and executes jobs in Docker sandboxes.

Usage: pulserun-daemon [options]

Options:
  --once       run one poll cycle, then exit (cron-friendly)
  -h, --help   show this help
  -v, --version  print the daemon version

Configuration is read from the environment:
  PULSERUN_CONTRACT_ID          escrow contract ID (required)
  PULSERUN_SECRET_KEY           runner Stellar secret key (required)
  PULSERUN_NETWORK              testnet | futurenet | mainnet | local
  PULSERUN_RPC_URL              Soroban RPC endpoint override
  PULSERUN_POLL_INTERVAL_MS     delay between event polls
  PULSERUN_START_LEDGER_OFFSET  ledgers behind the head to start from
  PULSERUN_DOCKER_HOST          unix://, npipe:// or tcp:// Docker endpoint
  PULSERUN_CPU_LIMIT            sandbox CPU limit in cores
  PULSERUN_MEMORY_LIMIT_MB      sandbox memory limit in MiB
  PULSERUN_PIDS_LIMIT           sandbox process limit
  PULSERUN_ALLOW_NETWORK        true to give sandboxes network access
  PULSERUN_JOB_TIMEOUT_SECONDS  hard wall-clock limit per job
  PULSERUN_MAX_CONCURRENCY      jobs executed in parallel
  PULSERUN_LOG_LEVEL            debug | info | warn | error`;

export interface ParsedArgs {
  once: boolean;
  help: boolean;
  version: boolean;
}

/** Parses CLI flags; configuration itself comes from the environment. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { once: false, help: false, version: false };

  for (const arg of argv) {
    switch (arg) {
      case '--once':
        parsed.once = true;
        break;
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '-v':
      case '--version':
        parsed.version = true;
        break;
      default:
        throw new DaemonError(`Unknown argument "${arg}". Run "pulserun-daemon --help" for usage.`);
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

export interface JobProcessorDependencies {
  executor: Pick<DockerExecutor, 'execute'>;
  submitter: ProofSubmitter;
  logger: Logger;
  /** Overrides "now" in unix seconds; used by tests. */
  now?: () => number;
}

/**
 * Timeout for a single sandbox: the smaller of the daemon ceiling and the
 * on-chain deadline. Always at least one second.
 */
export function computeTimeoutSeconds(
  deadline: number,
  nowSeconds: number,
  maxTimeoutSeconds: number,
): number {
  const remaining = deadline - nowSeconds;
  if (remaining <= 0) return 0;
  return Math.max(1, Math.min(Math.floor(remaining), Math.floor(maxTimeoutSeconds)));
}

/**
 * Executes one job and submits its proof.
 *
 * @returns the execution result, or `null` when the job's deadline had already
 *   passed and nothing was run.
 * @throws {DaemonError} when the job is malformed or proof submission fails.
 */
export async function processJob(
  job: JobCreatedEvent,
  deps: JobProcessorDependencies,
  maxTimeoutSeconds: number,
): Promise<ExecutionResult | null> {
  const logger = deps.logger;
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  const timeoutSeconds = computeTimeoutSeconds(job.deadline, nowSeconds, maxTimeoutSeconds);

  if (timeoutSeconds === 0) {
    logger.warn(`Job #${job.jobId}: deadline passed ${nowSeconds - job.deadline}s ago; skipping.`);
    return null;
  }

  if (!job.image.trim()) throw new DaemonError(`Job #${job.jobId} has an empty image.`);
  if (!job.command.trim()) throw new DaemonError(`Job #${job.jobId} has an empty command.`);

  const request: ExecutionRequest = {
    jobId: job.jobId,
    image: job.image,
    command: job.command,
    timeoutSeconds,
  };

  const result = await deps.executor.execute(request);
  const proof = buildProof({
    exitCode: result.exitCode,
    logs: result.logs,
    timedOut: result.timedOut,
  });

  await submitProof(job, proof, deps);

  return result;
}

async function submitProof(
  job: JobCreatedEvent,
  proof: ExecutionProof,
  deps: JobProcessorDependencies,
): Promise<void> {
  const submission = await deps.submitter.submit({
    jobId: job.jobId,
    outputHash: proof.outputHash,
    exitCode: proof.exitCode,
    success: proof.success,
  });
  deps.logger.info(
    `Job #${job.jobId}: proof submitted (${formatProof(job.jobId, proof)}) tx ${submission.txHash}, ledger ${submission.ledger}.`,
  );
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export interface TaskLimiter {
  /** Number of tasks currently running. */
  readonly active: number;
  /** Runs `task` once a slot frees up. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Bounds how many jobs run at the same time. */
export function createTaskLimiter(maxConcurrency: number): TaskLimiter {
  const limit = Math.max(1, Math.floor(maxConcurrency));
  let active = 0;
  const waiting: Array<() => void> = [];

  return {
    get active() {
      return active;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export interface DaemonDependencies {
  logger?: Logger;
  runtime?: ContainerRuntime;
  submitter?: ProofSubmitter;
  source?: {
    getLatestLedger(): Promise<{ sequence: number }>;
    getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
  };
}

/** Creates the Soroban RPC server used by the watcher. */
function createSource(config: DaemonConfig): rpc.Server {
  return new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') });
}

/**
 * Runs the daemon until `signal` aborts.
 *
 * @returns the number of jobs processed (useful for `--once`).
 */
export async function runDaemon(
  config: DaemonConfig,
  signal: AbortSignal,
  deps: DaemonDependencies = {},
): Promise<number> {
  const logger = deps.logger ?? createLogger({ level: config.logLevel });

  const runtime = deps.runtime ?? createDockerRuntime({ dockerHost: config.dockerHost });
  const executor = new DockerExecutor({
    runtime,
    logger,
    limits: {
      cpuLimit: config.cpuLimit,
      memoryLimitMb: config.memoryLimitMb,
      pidsLimit: config.pidsLimit,
      allowNetwork: config.allowNetwork,
    },
  });

  const submitter =
    deps.submitter ??
    new SorobanProofSubmitter({
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      contractId: config.contractId,
      secretKey: config.secretKey,
    });

  const watcher = new JobWatcher({
    source: deps.source ?? createSource(config),
    contractId: config.contractId,
    runner: config.runnerPublicKey,
    pollIntervalMs: config.pollIntervalMs,
    startLedgerOffset: config.startLedgerOffset,
    pageLimit: config.eventPageLimit,
    logger,
  });

  const limiter = createTaskLimiter(config.maxConcurrency);
  const inFlight = new Set<Promise<void>>();
  let processed = 0;

  const processor: JobProcessorDependencies = { executor, submitter, logger };

  const handleJob = async (job: JobCreatedEvent): Promise<void> => {
    processed += 1;
    logger.info(
      `Job #${job.jobId}: image ${job.image}, budget ${job.maxBudgetStroops} stroops, deadline ${job.deadline}`,
    );
    try {
      await processJob(job, processor, config.jobTimeoutSeconds);
    } catch (error) {
      // Leave the job alone: it will be retried on the next event poll (or
      // expire), rather than being marked failed because of a local fault.
      logger.error(
        `Job #${job.jobId} failed locally: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  logger.info(
    `pulserun-daemon ${DAEMON_VERSION} for ${config.runnerPublicKey} on ${config.network} ` +
      `(concurrency ${config.maxConcurrency}, timeout ${config.jobTimeoutSeconds}s).`,
  );

  const poll = async (): Promise<void> => {
    const jobs = await watcher.pollOnce();
    for (const job of jobs) {
      const task = limiter
        .run(() => handleJob(job))
        .catch((error: unknown) => {
          logger.error(`Job #${job.jobId} handler crashed: ${String(error)}`);
        })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
  };

  try {
    while (!signal.aborted) {
      try {
        await poll();
      } catch (error) {
        logger.warn(`Event poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (config.once || signal.aborted) break;
      await sleep(config.pollIntervalMs, signal);
    }
  } finally {
    // Wait for any sandboxes still running so a shutdown never orphans them.
    await Promise.allSettled([...inFlight]);
  }

  logger.info(`pulserun-daemon stopped after processing ${processed} job(s).`);
  return processed;
}

/** Sleeps for `ms`, resolving early when the signal is aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }

    signal?.addEventListener('abort', finish, { once: true });
  });
}

export interface MainOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Overrides the abort signal; defaults to SIGINT/SIGTERM handlers. */
  signal?: AbortSignal;
}

/** CLI entrypoint: parse args, load config and run until interrupted. */
export async function main(options: MainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    createLogger({ level: 'error' }).error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${DAEMON_VERSION}\n`);
    return 0;
  }

  let config: DaemonConfig;
  try {
    config = loadConfig(options.env ?? process.env, { once: parsed.once });
  } catch (error) {
    createLogger({ level: 'error' }).error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const controller = new AbortController();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    (options.logger ?? createLogger({ level: config.logLevel })).info(
      `Received ${signal}; shutting down.`,
    );
    controller.abort();
  };
  if (!external) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  try {
    await runDaemon(config, controller.signal, { logger: options.logger });
    return 0;
  } catch (error) {
    createLogger({ level: 'error' }).error(
      `pulserun-daemon: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    if (!external) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}
