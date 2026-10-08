import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  type DaemonConfig,
  type Logger,
  DEFAULT_CONFIG,
  DaemonError,
  loadConfig,
} from '../src/config.js';
import type { ComputeJob } from '../src/contract.js';
import type { ContainerHandle, ContainerRuntime } from '../src/executor.js';
import type { JobSpecStore } from '../src/specs.js';
import {
  type RunnerEscrowApi,
  computeTimeoutSeconds,
  createTaskLimiter,
  main,
  parseArgs,
  processJob,
  runDaemon,
} from '../src/index.js';

const SECRET = Keypair.random().secret();
const RUNNER = Keypair.fromSecret(SECRET).publicKey();
const REQUESTER = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 5));
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 4));

function createLoggerSpy() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

function makeJob(overrides: Partial<ComputeJob> = {}): ComputeJob {
  const now = Math.floor(Date.now() / 1000);
  return {
    jobId: 1n,
    requester: REQUESTER,
    runner: RUNNER,
    paymentToken: TOKEN,
    maxBudget: 15_000_000n,
    ratePerSecond: 1_000n,
    maxDurationSecs: 600,
    status: 'Queued',
    createdAt: now,
    completedAt: 0,
    outputHash: `0x${'00'.repeat(32)}`,
    ...overrides,
  };
}

function createRuntime(handle: ContainerHandle): ContainerRuntime {
  return { pullImage: vi.fn(async () => {}), create: vi.fn(async () => handle) };
}

function createHandle(options: { logs?: string; exitCode?: number } = {}): ContainerHandle {
  return {
    id: 'container-123456789abc',
    wait: vi.fn(async () => ({ statusCode: options.exitCode ?? 0 })),
    logs: vi.fn(async () => Buffer.from(options.logs ?? 'ok', 'utf8')),
    inspect: vi.fn(async () => ({ exitCode: options.exitCode ?? 0, oomKilled: false })),
    kill: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

function createSpecStore(spec = { image: 'alpine', command: 'true' }): JobSpecStore {
  return { get: vi.fn(async () => spec) };
}

function fakeEscrow(jobs: ComputeJob[]) {
  const store = new Map(jobs.map((job) => [job.jobId, job]));
  const submitProof = vi.fn(async (params: { jobId: bigint }) => {
    const job = store.get(params.jobId);
    if (job) {
      job.status = 'Completed';
      job.completedAt = Math.floor(Date.now() / 1000);
    }
    return { txHash: 'tx'.padEnd(64, '0'), ledger: 1 };
  });
  const claimPayout = vi.fn(async () => ({
    txHash: 'tx2'.padEnd(64, '0'),
    ledger: 2,
    earnings: 900n,
  }));
  const highestId = [...store.keys()].reduce((max, id) => (id > max ? id : max), 0n);
  const api: RunnerEscrowApi = {
    jobCount: vi.fn(async () => highestId),
    getJob: vi.fn(async (jobId: bigint) => {
      const job = store.get(jobId);
      if (!job) throw new Error(`job ${jobId} missing`);
      return job;
    }),
    disputeWindow: vi.fn(async () => 0),
    submitProof,
    claimPayout,
  };
  return { api, store, submitProof, claimPayout };
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    ...loadConfig({ PULSEESCROW_ID: CONTRACT_ID, PULSERUN_SECRET_KEY: SECRET }),
    once: true,
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('parses supported flags and rejects unknown ones', () => {
    expect(parseArgs([])).toEqual({ once: false, help: false, version: false });
    expect(parseArgs(['--once'])).toEqual({ once: true, help: false, version: false });
    expect(() => parseArgs(['--nope'])).toThrowError(DaemonError);
  });
});

describe('computeTimeoutSeconds', () => {
  it('caps at the daemon ceiling and shrinks to the expiry', () => {
    expect(computeTimeoutSeconds(5_000, 1_000, 900)).toBe(900);
    expect(computeTimeoutSeconds(1_100, 1_000, 900)).toBe(100);
    expect(computeTimeoutSeconds(1_000, 1_000, 900)).toBe(0);
    expect(computeTimeoutSeconds(900, 1_000, 900)).toBe(0);
  });
});

describe('createTaskLimiter', () => {
  it('never runs more than the configured number of tasks', async () => {
    const limiter = createTaskLimiter(2);
    let running = 0;
    let peak = 0;

    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    };

    await Promise.all([limiter.run(task), limiter.run(task), limiter.run(task), limiter.run(task)]);
    expect(peak).toBe(2);
    expect(limiter.active).toBe(0);
  });
});

describe('processJob', () => {
  const logger = createLoggerSpy();

  it('executes a job and submits a metered proof', async () => {
    const { api, submitProof } = fakeEscrow([makeJob()]);
    const executor = {
      execute: vi.fn(async () => ({
        jobId: 1n,
        exitCode: 0,
        logs: 'all tests passed',
        durationMs: 12_400,
        timedOut: false,
        oomKilled: false,
      })),
    };

    const result = await processJob(
      makeJob(),
      { executor, escrow: api, specs: createSpecStore(), logger },
      900,
    );

    expect(result?.exitCode).toBe(0);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 1n, image: 'alpine', command: 'true' }),
    );
    expect(submitProof).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 1n, durationSecs: 13, exitCode: 0 }),
    );
  });

  it('skips jobs whose expiry already passed', async () => {
    const { api, submitProof } = fakeEscrow([makeJob()]);
    const executor = { execute: vi.fn() };
    const job = makeJob({ createdAt: Math.floor(Date.now() / 1000) - 10_000, maxDurationSecs: 60 });

    const result = await processJob(
      job,
      { executor, escrow: api, specs: createSpecStore(), logger },
      900,
    );

    expect(result).toBeNull();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(submitProof).not.toHaveBeenCalled();
  });

  it('skips jobs with no recorded spec', async () => {
    const { api, submitProof } = fakeEscrow([makeJob()]);
    const executor = { execute: vi.fn() };
    const specs: JobSpecStore = { get: vi.fn(async () => null) };

    const result = await processJob(makeJob(), { executor, escrow: api, specs, logger }, 900);

    expect(result).toBeNull();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(submitProof).not.toHaveBeenCalled();
  });

  it('propagates proof-submission failures so the caller can retry', async () => {
    const { api } = fakeEscrow([makeJob()]);
    (api.submitProof as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rpc down'));
    const executor = {
      execute: vi.fn(async () => ({
        jobId: 1n,
        exitCode: 0,
        logs: 'ok',
        durationMs: 1_000,
        timedOut: false,
        oomKilled: false,
      })),
    };

    await expect(
      processJob(makeJob(), { executor, escrow: api, specs: createSpecStore(), logger }, 900),
    ).rejects.toThrowError(/rpc down/);
  });
});

describe('runDaemon', () => {
  it('discovers a queued job, proves it and settles the payout', async () => {
    const { api, submitProof, claimPayout } = fakeEscrow([makeJob()]);
    const logger = createLoggerSpy();

    const processed = await runDaemon(makeConfig(), new AbortController().signal, {
      logger,
      runtime: createRuntime(createHandle({ logs: 'ok', exitCode: 0 })),
      escrow: api,
      specs: createSpecStore(),
    });

    expect(processed).toBe(1);
    expect(submitProof).toHaveBeenCalledOnce();
    expect(claimPayout).toHaveBeenCalledWith(1n);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not claim when autoClaim is disabled', async () => {
    const { api, claimPayout } = fakeEscrow([makeJob()]);
    await runDaemon(makeConfig({ autoClaimPayout: false }), new AbortController().signal, {
      logger: createLoggerSpy(),
      runtime: createRuntime(createHandle()),
      escrow: api,
      specs: createSpecStore(),
    });
    expect(claimPayout).not.toHaveBeenCalled();
  });

  it('never submits a proof when the sandbox fails locally', async () => {
    const { api, submitProof } = fakeEscrow([makeJob()]);
    const logger = createLoggerSpy();
    const runtime: ContainerRuntime = {
      pullImage: vi.fn(async () => {
        throw new Error('docker is down');
      }),
      create: vi.fn(async () => createHandle()),
    };

    const processed = await runDaemon(makeConfig(), new AbortController().signal, {
      logger,
      runtime,
      escrow: api,
      specs: createSpecStore(),
    });

    expect(processed).toBe(0);
    expect(submitProof).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed locally: docker is down'),
    );
  });

  it('ignores jobs addressed to other runners', async () => {
    const other = makeJob({ jobId: 1n, runner: Keypair.random().publicKey() });
    const { api, submitProof } = fakeEscrow([other]);

    const processed = await runDaemon(makeConfig(), new AbortController().signal, {
      logger: createLoggerSpy(),
      runtime: createRuntime(createHandle()),
      escrow: api,
      specs: createSpecStore(),
    });

    expect(processed).toBe(0);
    expect(submitProof).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  it('prints usage for --help and the version for --version', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(main({ argv: ['--help'] })).resolves.toBe(0);
      expect(out).toHaveBeenCalledWith(expect.stringContaining('pulserun-daemon'));
      await expect(main({ argv: ['--version'] })).resolves.toBe(0);
    } finally {
      out.mockRestore();
    }
  });

  it('fails fast on unknown arguments and missing configuration', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(main({ argv: ['--nope'] })).resolves.toBe(1);
      await expect(main({ argv: [], env: {}, logger: createLoggerSpy() })).resolves.toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it('exposes the documented defaults', () => {
    expect(DEFAULT_CONFIG.pollIntervalMs).toBe(5_000);
    expect(DEFAULT_CONFIG.jobTimeoutSeconds).toBe(900);
    expect(DEFAULT_CONFIG.autoClaimPayout).toBe(true);
  });
});
