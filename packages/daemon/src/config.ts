/**
 * Runner daemon configuration and logging.
 *
 * The daemon is configured entirely through environment variables so it can run
 * as a systemd unit, a container or a Kubernetes deployment without a config
 * file. Logging lives here too because every daemon module takes a
 * {@link Logger}.
 */

import { Keypair, Networks } from '@stellar/stellar-sdk';

/** Any error raised by the runner daemon. */
export class DaemonError extends Error {
  override readonly name = 'DaemonError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Adds an ISO-8601 prefix; disabled by tests for stable assertions. */
  timestamps?: boolean;
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  try {
    stream.write(`${line}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
  }
}

/** Creates a level-filtered logger writing `warn`/`error` to stderr. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const threshold = LEVEL_WEIGHT[options.level ?? 'info'];
  const timestamps = options.timestamps ?? true;

  const emit = (level: LogLevel, stream: NodeJS.WritableStream, message: string): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const prefix = timestamps ? `${new Date().toISOString()} ` : '';
    writeLine(stream, `${prefix}${level.toUpperCase().padEnd(5)} ${message}`);
  };

  return {
    debug: (message) => emit('debug', stdout, message),
    info: (message) => emit('info', stdout, message),
    warn: (message) => emit('warn', stderr, message),
    error: (message) => emit('error', stderr, message),
  };
}

/** A logger that discards everything; handy for tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export interface NetworkPreset {
  rpcUrl: string;
  networkPassphrase: string;
}

export const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: Networks.FUTURENET,
  },
  mainnet: {
    rpcUrl: 'https://soroban-mainnet.stellar.org',
    networkPassphrase: Networks.PUBLIC,
  },
  local: {
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: Networks.STANDALONE,
  },
};

export const DEFAULT_NETWORK = 'testnet';

/** Resolves a network name into its RPC URL and passphrase preset. */
export function resolveNetwork(name: string | undefined): NetworkPreset {
  const key = (name ?? DEFAULT_NETWORK).trim().toLowerCase();
  const preset = NETWORK_PRESETS[key];
  if (!preset) {
    throw new DaemonError(
      `Unknown network "${name}". Expected one of: ${Object.keys(NETWORK_PRESETS).join(', ')}.`,
    );
  }
  return preset;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** PulseEscrow contract ID whose jobs are watched. */
  contractId: string;
  secretKey: string;
  /** Public key derived from {@link secretKey}; jobs for other runners are ignored. */
  runnerPublicKey: string;
  /** Delay between chain polls, in milliseconds. */
  pollIntervalMs: number;
  /**
   * JSON file mapping job id to `{ image, command }`. The contract does not
   * carry the command line yet (pulserun-core tracks an on-chain metadata hash
   * as planned work), so the runner reads the spec out of band.
   */
  jobSpecsFile: string;
  /** Docker endpoint, e.g. `unix:///var/run/docker.sock`. */
  dockerHost: string;
  /** CPU limit in cores (fractional values allowed). */
  cpuLimit: number;
  /** Memory limit in mebibytes. */
  memoryLimitMb: number;
  /** Maximum number of processes inside the sandbox. */
  pidsLimit: number;
  /** When false, the sandbox has no network access. */
  allowNetwork: boolean;
  /** Hard wall-clock limit for a single job, in seconds. */
  jobTimeoutSeconds: number;
  /** Maximum number of jobs executed concurrently. */
  maxConcurrency: number;
  /** Whether the daemon claims payouts once the dispute window has elapsed. */
  autoClaimPayout: boolean;
  logLevel: LogLevel;
  /** Process one poll cycle and exit; useful for cron-style operation. */
  once: boolean;
}

export interface DaemonConfigOverrides {
  once?: boolean;
  logLevel?: LogLevel;
}

export const DEFAULT_CONFIG = {
  pollIntervalMs: 5_000,
  jobSpecsFile: './pulserun-jobs.json',
  dockerHost: 'unix:///var/run/docker.sock',
  cpuLimit: 1,
  memoryLimitMb: 1024,
  pidsLimit: 256,
  allowNetwork: false,
  jobTimeoutSeconds: 900,
  maxConcurrency: 1,
  autoClaimPayout: true,
  logLevel: 'info' as LogLevel,
} as const;

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { min: number; max?: number } = { min: 0 },
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < bounds.min) {
    throw new DaemonError(`${name} must be a number >= ${bounds.min}; received "${raw}".`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new DaemonError(`${name} must be <= ${bounds.max}; received "${raw}".`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new DaemonError(`${name} must be a boolean; received "${raw}".`);
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.PULSERUN_LOG_LEVEL ?? DEFAULT_CONFIG.logLevel).trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  throw new DaemonError(`PULSERUN_LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}.`);
}

/**
 * Loads and validates the daemon configuration.
 *
 * @throws {DaemonError} when the contract ID, secret key or any override is
 *   missing or malformed.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: DaemonConfigOverrides = {},
): DaemonConfig {
  const network = (env.PULSERUN_NETWORK ?? DEFAULT_NETWORK).trim();
  const preset = resolveNetwork(network);
  const contractId = (env.PULSEESCROW_ID ?? env.PULSERUN_CONTRACT_ID ?? '').trim();
  const secretKey = (env.PULSERUN_SECRET_KEY ?? '').trim();

  if (!contractId) {
    throw new DaemonError('PULSEESCROW_ID is required (the PulseEscrow contract C...).');
  }
  if (!secretKey) {
    throw new DaemonError('PULSERUN_SECRET_KEY is required (the runner Stellar secret key S...).');
  }

  let runnerPublicKey: string;
  try {
    runnerPublicKey = Keypair.fromSecret(secretKey).publicKey();
  } catch (error) {
    throw new DaemonError(
      'PULSERUN_SECRET_KEY is not a valid Stellar secret key for the selected network.',
      { cause: error },
    );
  }

  return {
    network,
    networkPassphrase: (env.STELLAR_NETWORK_PASSPHRASE ?? preset.networkPassphrase).trim(),
    rpcUrl: (env.STELLAR_RPC_URL ?? env.PULSERUN_RPC_URL ?? preset.rpcUrl).trim(),
    contractId,
    secretKey,
    runnerPublicKey,
    pollIntervalMs: readInt(env, 'PULSERUN_POLL_INTERVAL_MS', DEFAULT_CONFIG.pollIntervalMs, {
      min: 250,
    }),
    jobSpecsFile: (env.PULSERUN_JOB_SPECS_FILE ?? DEFAULT_CONFIG.jobSpecsFile).trim(),
    dockerHost: (env.PULSERUN_DOCKER_HOST ?? DEFAULT_CONFIG.dockerHost).trim(),
    cpuLimit: readInt(env, 'PULSERUN_CPU_LIMIT', DEFAULT_CONFIG.cpuLimit, { min: 0.1, max: 64 }),
    memoryLimitMb: readInt(env, 'PULSERUN_MEMORY_LIMIT_MB', DEFAULT_CONFIG.memoryLimitMb, {
      min: 16,
    }),
    pidsLimit: readInt(env, 'PULSERUN_PIDS_LIMIT', DEFAULT_CONFIG.pidsLimit, { min: 8 }),
    allowNetwork: readBool(env, 'PULSERUN_ALLOW_NETWORK', DEFAULT_CONFIG.allowNetwork),
    jobTimeoutSeconds: readInt(
      env,
      'PULSERUN_JOB_TIMEOUT_SECONDS',
      DEFAULT_CONFIG.jobTimeoutSeconds,
      { min: 1 },
    ),
    maxConcurrency: readInt(env, 'PULSERUN_MAX_CONCURRENCY', DEFAULT_CONFIG.maxConcurrency, {
      min: 1,
      max: 64,
    }),
    autoClaimPayout: readBool(env, 'PULSERUN_AUTO_CLAIM', DEFAULT_CONFIG.autoClaimPayout),
    logLevel: overrides.logLevel ?? readLogLevel(env),
    once: overrides.once ?? readBool(env, 'PULSERUN_ONCE', false),
  };
}

/** Parses a `PULSERUN_DOCKER_HOST` value into dockerode connection options. */
export function dockerOptionsFromHost(host: string): {
  socketPath?: string;
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
} {
  const value = host.trim();
  if (value.startsWith('unix://')) {
    return { socketPath: value.slice('unix://'.length) };
  }
  if (/^npipe:\/{2,}/i.test(value)) {
    // `npipe:////./pipe/docker_engine` -> `//./pipe/docker_engine`, the path
    // dockerode passes to Node's net module on Windows.
    return { socketPath: value.replace(/^npipe:\/{2,}/i, '//') };
  }
  if (value.startsWith('tcp://') || value.startsWith('http://') || value.startsWith('https://')) {
    const url = new URL(value.replace(/^tcp:\/\//, 'http://'));
    const protocol = url.protocol === 'https:' ? 'https' : 'http';
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : protocol === 'https' ? 2376 : 2375,
      protocol,
    };
  }
  throw new DaemonError(
    `PULSERUN_DOCKER_HOST "${host}" is invalid: expected unix://, npipe://, tcp:// or http(s)://.`,
  );
}
