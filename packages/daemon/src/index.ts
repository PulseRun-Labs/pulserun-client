#!/usr/bin/env node
/**
 * `pulserun-daemon` entrypoint.
 *
 * Wires the runner responsibilities together:
 *
 * 1. {@link JobWatcher} polls the escrow for `Queued` jobs addressed to this
 *    runner (the contract emits no events yet).
 * 2. {@link DockerExecutor} runs each job in a resource-limited sandbox.
 * 3. The runner submits an `ExecutionProof` and, once the dispute window has
 *    elapsed, claims the payout so the escrow settles.
 */

import { DaemonError, type DaemonConfig, type Logger, createLogger, loadConfig } from './config.js';
import {
  type ClaimResult,
  type ComputeJob,
  type EscrowReader,
  type EscrowWriter,
  RunnerEscrow,
} from './contract.js';
import {
  type ContainerRuntime,
  type ExecutionRequest,
  type ExecutionResult,
  DockerExecutor,
  createDockerRuntime,
} from './executor.js';
import { buildProof, formatProof } from './proof.js';
import { type JobSpecStore, FileJobSpecStore } from './specs.js';
import { JobWatcher } from './watcher.js';

/** Version reported by `pulserun-daemon --version`. Keep in sync with package.json. */
export const DAEMON_VERSION = '0.1.0';

export const USAGE = `pulserun-daemon ${DAEMON_VERSION}
Watches the PulseEscrow contract and executes jobs in Docker sandboxes.

Usage: pulserun-daemon [options]

Options:
  --once         run one poll cycle, then exit (cron-friendly)
  -h, --help     show this help
  -v, --version  print the daemon version

Configuration is read from the environment:
  PULSEESCROW_ID                escrow contract ID (required)
  PULSERUN_SECRET_KEY           runner Stellar secret key (required)
  PULSERUN_NETWORK              testnet | futurenet | mainnet | local
  STELLAR_RPC_URL               Soroban RPC endpoint override
  STELLAR_NETWORK_PASSPHRASE    network passphrase override
  PULSERUN_JOB_SPECS_FILE       JSON file mapping job id -> { image, command }
  PULSERUN_POLL_INTERVAL_MS     delay between chain polls
  PULSERUN_DOCKER_HOST          unix://, npipe:// or tcp:// Docker endpoint
  PULSERUN_CPU_LIMIT            sandbox CPU limit in cores
  PULSERUN_MEMORY_LIMIT_MB      sandbox memory limit in MiB
  PULSERUN_PIDS_LIMIT           sandbox process limit
  PULSERUN_ALLOW_NETWORK        true to give sandboxes network access
  PULSERUN_JOB_TIMEOUT_SECONDS  hard wall-clock limit per job
  PULSERUN_MAX_CONCURRENCY      jobs executed in parallel
  PULSERUN_AUTO_CLAIM           claim payouts after the dispute window
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
  escrow: EscrowWriter;
  specs: JobSpecStore;
  logger: Logger;
  /** Overrides "now" in unix seconds; used by tests. */
  now?: () => number;
}

/** The escrow surface the runner loop uses (reads + writes). */
export interface RunnerEscrowApi extends EscrowReader, EscrowWriter {}

/**
 * Timeout for a single sandbox: the smaller of the daemon ceiling and the
 * job's on-chain expiry. Always at least one second.
 */
export function computeTimeoutSeconds(
  expiresAt: number,
  nowSeconds: number,
  maxTimeoutSeconds: number,
): number {
  const remaining = expiresAt - nowSeconds;
  if (remaining <= 0) return 0;
  return Math.max(1, Math.min(Math.floor(remaining), Math.floor(maxTimeoutSeconds)));
}

/**
 * Executes one job and submits its proof.
 *
 * @returns the execution result, or `null` when the job had no spec or its
 *   expiry had already passed.
 * @throws {DaemonError} when proof submission fails.
 */
export async function processJob(
  job: ComputeJob,
  deps: JobProcessorDependencies,
  maxTimeoutSeconds: number,
): Promise<ExecutionResult | null> {
  const logger = deps.logger;
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  const expiresAt = job.createdAt + job.maxDurationSecs;
  const timeoutSeconds = computeTimeoutSeconds(expiresAt, nowSeconds, maxTimeoutSeconds);

  if (timeoutSeconds === 0) {
    logger.warn(`Job #${job.jobId}: expiry passed ${nowSeconds - expiresAt}s ago; skipping.`);
    return null;
  }

  const spec = await deps.specs.get(job.jobId);
  if (!spec) {
    logger.warn(`Job #${job.jobId}: no spec recorded; add it to the job spec file to run it.`);
    return null;
  }

  const request: ExecutionRequest = {
    jobId: job.jobId,
    image: spec.image,
    command: spec.command,
    timeoutSeconds,
  };

  const result = await deps.executor.execute(request);
  const proof = buildProof({
    exitCode: result.exitCode,
    logs: result.logs,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  });

  const submission = await deps.escrow.submitProof({
    jobId: job.jobId,
    durationSecs: proof.durationSecs,
    exitCode: proof.exitCode,
    outputHash: proof.outputHash,
  });
  logger.info(
    `Job #${job.jobId}: proof submitted (${formatProof(job.jobId, proof)}) tx ${submission.txHash}, ledger ${submission.ledger}.`,
  );

  return result;
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
  escrow?: RunnerEscrowApi;
  specs?: JobSpecStore;
  /** Overrides "now" in unix seconds; used by tests. */
  now?: () => number;
}

/** Creates the escrow client used by the runner. */
function createEscrow(config: DaemonConfig): RunnerEscrow {
  return new RunnerEscrow({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    contractId: config.contractId,
    secretKey: config.secretKey,
  });
}

/**
 * Runs the daemon until `signal` aborts.
 *
 * @returns the number of jobs proven (useful for `--once`).
 */
export async function runDaemon(
  config: DaemonConfig,
  signal: AbortSignal,
  deps: DaemonDependencies = {},
): Promise<number> {
  const logger = deps.logger ?? createLogger({ level: config.logLevel });
  const now = deps.now ?? Date.now;

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

  const escrow = deps.escrow ?? createEscrow(config);
  const specs = deps.specs ?? new FileJobSpecStore({ path: config.jobSpecsFile, logger });

  const watcher = new JobWatcher({
    source: escrow,
    runner: config.runnerPublicKey,
    logger,
  });

  const limiter = createTaskLimiter(config.maxConcurrency);
  const inFlight = new Set<string>();
  const tasks = new Set<Promise<void>>();
  /** Jobs proven but not yet settled, awaiting the dispute window. */
  const proven = new Set<string>();
  let processed = 0;

  const processor: JobProcessorDependencies = { executor, escrow, specs, logger, now };

  const handleJob = async (job: ComputeJob): Promise<void> => {
    logger.info(
      `Job #${job.jobId}: budget ${job.maxBudget} base units, duration ${job.maxDurationSecs}s.`,
    );
    const result = await processJob(job, processor, config.jobTimeoutSeconds);
    if (result) {
      processed += 1;
      proven.add(job.jobId.toString());
    }
  };

  const reconcileClaims = async (): Promise<void> => {
    if (!config.autoClaimPayout || proven.size === 0) return;
    let disputeWindowSecs: number;
    try {
      disputeWindowSecs = await escrow.disputeWindow();
    } catch (error) {
      logger.warn(`Could not read the dispute window: ${describe(error)}`);
      return;
    }

    const nowSeconds = Math.floor(now() / 1000);
    for (const key of [...proven]) {
      try {
        const job = await escrow.getJob(BigInt(key));
        if (job.status !== 'Completed') {
          proven.delete(key);
          continue;
        }
        if (nowSeconds < job.completedAt + disputeWindowSecs) continue;
        const claim: ClaimResult = await escrow.claimPayout(BigInt(key));
        logger.info(
          `Job #${key}: settled; runner paid ${claim.earnings} base units (tx ${claim.txHash}, ledger ${claim.ledger}).`,
        );
        proven.delete(key);
      } catch (error) {
        logger.warn(`Job #${key}: claim attempt failed: ${describe(error)}`);
      }
    }
  };

  logger.info(
    `pulserun-daemon ${DAEMON_VERSION} for ${config.runnerPublicKey} on ${config.network} ` +
      `(concurrency ${config.maxConcurrency}, timeout ${config.jobTimeoutSeconds}s).`,
  );

  const poll = async (): Promise<void> => {
    const jobs = await watcher.pollOnce();
    for (const job of jobs) {
      const key = job.jobId.toString();
      if (inFlight.has(key) || proven.has(key)) continue;
      inFlight.add(key);
      const task = limiter
        .run(() => handleJob(job))
        .catch((error: unknown) => {
          // A local failure must never submit a wrong proof: log and retry next poll.
          logger.error(`Job #${job.jobId} failed locally: ${describe(error)}`);
        })
        .finally(() => {
          inFlight.delete(key);
          tasks.delete(task);
        });
      tasks.add(task);
    }
    await reconcileClaims();
  };

  try {
    while (!signal.aborted) {
      try {
        await poll();
      } catch (error) {
        logger.warn(`Chain poll failed: ${describe(error)}`);
      }

      if (config.once || signal.aborted) break;
      await sleep(config.pollIntervalMs, signal);
    }
  } finally {
    // Wait for any sandboxes still running so a shutdown never orphans them.
    await Promise.allSettled([...tasks]);
  }

  // Settle anything we just proved before exiting (relevant for `--once`).
  await reconcileClaims().catch((error: unknown) => {
    logger.warn(`Final settle pass failed: ${describe(error)}`);
  });

  logger.info(`pulserun-daemon stopped after proving ${processed} job(s).`);
  return processed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
