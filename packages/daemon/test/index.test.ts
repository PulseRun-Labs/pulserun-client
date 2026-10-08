import { Address, Keypair, StrKey, type rpc, nativeToScVal } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  type DaemonConfig,
  type Logger,
  DEFAULT_CONFIG,
  DaemonError,
  loadConfig,
} from '../src/config.js';
import type { ContainerHandle, ContainerRuntime } from '../src/executor.js';
import { type ProofSubmitter, hashLogs } from '../src/proof.js';
import type { JobCreatedEvent } from '../src/watcher.js';
import {
  computeTimeoutSeconds,
  createTaskLimiter,
  main,
  parseArgs,
  processJob,
  runDaemon,
} from '../src/index.js';

const SECRET = Keypair.random().secret();
const RUNNER = Keypair.fromSecret(SECRET).publicKey();
const CLIENT = Keypair.random().publicKey();
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 4));

function createLoggerSpy() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

function makeJob(overrides: Partial<JobCreatedEvent> = {}): JobCreatedEvent {
  return {
    jobId: 7n,
    client: CLIENT,
    runner: RUNNER,
    image: 'node:22-alpine',
    command: 'pnpm test',
    maxBudgetStroops: 15_000_000n,
    deadline: Math.floor(Date.now() / 1000) + 600,
    ledger: 100,
    txHash: 'a'.repeat(64),
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

function createSubmitter() {
  const submit = vi.fn(async (params) => ({
    txHash: 'tx'.padEnd(64, '0'),
    ledger: 55,
    outputHash: params.outputHash,
  }));
  return { submitter: { submit } as ProofSubmitter, submit };
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    ...loadConfig({ PULSERUN_CONTRACT_ID: CONTRACT_ID, PULSERUN_SECRET_KEY: SECRET }),
    once: true,
    ...overrides,
  };
}

function makeEvent(job: JobCreatedEvent): rpc.Api.EventResponse {
  return {
    id: 'event-1',
    type: 'contract',
    ledger: job.ledger,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: job.txHash,
    topic: [nativeToScVal('job_created', { type: 'symbol' }), new Address(job.runner).toScVal()],
    value: nativeToScVal({
      job_id: job.jobId,
      client: job.client,
      image: job.image,
      cmd: job.command,
      max_budget: job.maxBudgetStroops,
      deadline: BigInt(job.deadline),
    }),
  } as unknown as rpc.Api.EventResponse;
}

describe('parseArgs', () => {
  it('parses supported flags', () => {
    expect(parseArgs([])).toEqual({ once: false, help: false, version: false });
    expect(parseArgs(['--once'])).toEqual({ once: true, help: false, version: false });
    expect(parseArgs(['-h'])).toEqual({ once: false, help: true, version: false });
    expect(parseArgs(['--version'])).toEqual({ once: false, help: false, version: true });
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrowError(DaemonError);
    expect(() => parseArgs(['--nope'])).toThrowError(/Unknown argument "--nope"/);
  });
});

describe('computeTimeoutSeconds', () => {
  it('caps the sandbox at the daemon ceiling', () => {
    expect(computeTimeoutSeconds(5_000, 1_000, 900)).toBe(900);
  });

  it('shrinks to the remaining on-chain deadline', () => {
    expect(computeTimeoutSeconds(1_100, 1_000, 900)).toBe(100);
  });

  it('returns zero for an expired job', () => {
    expect(computeTimeoutSeconds(1_000, 1_000, 900)).toBe(0);
    expect(computeTimeoutSeconds(900, 1_000, 900)).toBe(0);
  });

  it('rounds sub-second budgets up to one second', () => {
    expect(computeTimeoutSeconds(1_000.9, 1_000, 900)).toBe(1);
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

  it('treats a non-positive limit as one', async () => {
    const limiter = createTaskLimiter(0);
    await expect(limiter.run(async () => 'done')).resolves.toBe('done');
  });
});

describe('processJob', () => {
  it('executes the job and submits a success proof', async () => {
    const { submitter, submit } = createSubmitter();
    const executor = {
      execute: vi.fn(async () => ({
        jobId: 7n,
        exitCode: 0,
        logs: 'all tests passed',
        durationMs: 12,
        timedOut: false,
        oomKilled: false,
      })),
    };

    const result = await processJob(
      makeJob(),
      { executor, submitter, logger: createLoggerSpy() },
      900,
    );

    expect(result?.exitCode).toBe(0);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 7n, image: 'node:22-alpine', command: 'pnpm test' }),
    );
    expect(submit).toHaveBeenCalledWith({
      jobId: 7n,
      outputHash: hashLogs('all tests passed'),
      exitCode: 0,
      success: true,
    });
  });

  it('submits a failure proof for a non-zero exit code', async () => {
    const { submitter, submit } = createSubmitter();
    const executor = {
      execute: vi.fn(async () => ({
        jobId: 7n,
        exitCode: 3,
        logs: 'boom',
        durationMs: 5,
        timedOut: false,
        oomKilled: false,
      })),
    };

    await processJob(makeJob(), { executor, submitter, logger: createLoggerSpy() }, 900);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 3, success: false }));
  });

  it('skips jobs whose deadline already passed', async () => {
    const executor = { execute: vi.fn() };
    const { submitter, submit } = createSubmitter();

    const result = await processJob(
      makeJob({ deadline: Math.floor(Date.now() / 1000) - 60 }),
      { executor, submitter, logger: createLoggerSpy() },
      900,
    );

    expect(result).toBeNull();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects malformed jobs before running a container', async () => {
    const executor = { execute: vi.fn() };
    const { submitter } = createSubmitter();

    await expect(
      processJob(makeJob({ image: ' ' }), { executor, submitter, logger: createLoggerSpy() }, 900),
    ).rejects.toThrowError(/empty image/);
    await expect(
      processJob(makeJob({ command: '' }), { executor, submitter, logger: createLoggerSpy() }, 900),
    ).rejects.toThrowError(/empty command/);
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

describe('runDaemon', () => {
  it('executes a job found on-chain and settles its proof', async () => {
    const job = makeJob();
    const handle = createHandle({ logs: 'ok', exitCode: 0 });
    const { submitter, submit } = createSubmitter();
    const logger = createLoggerSpy();

    const getEvents = vi.fn(
      async () =>
        ({
          events: [makeEvent(job)],
          cursor: 'c1',
          latestLedger: 200,
          oldestLedger: 1,
          latestLedgerCloseTime: '2026-01-01T00:00:00Z',
          oldestLedgerCloseTime: '2026-01-01T00:00:00Z',
        }) as rpc.Api.GetEventsResponse,
    );

    const processed = await runDaemon(makeConfig(), new AbortController().signal, {
      logger,
      runtime: createRuntime(handle),
      submitter,
      source: { getLatestLedger: vi.fn(async () => ({ sequence: 200 })), getEvents },
    });

    expect(processed).toBe(1);
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ jobId: 7n, success: true }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps going when a job fails locally without submitting a proof', async () => {
    const handle = createHandle();
    const runtime: ContainerRuntime = {
      pullImage: vi.fn(async () => {
        throw new Error('docker is down');
      }),
      create: vi.fn(async () => handle),
    };
    const { submitter, submit } = createSubmitter();
    const logger = createLoggerSpy();

    const getEvents = vi.fn(
      async () =>
        ({
          events: [makeEvent(makeJob())],
          cursor: 'c1',
          latestLedger: 200,
          oldestLedger: 1,
          latestLedgerCloseTime: '2026-01-01T00:00:00Z',
          oldestLedgerCloseTime: '2026-01-01T00:00:00Z',
        }) as rpc.Api.GetEventsResponse,
    );

    const processed = await runDaemon(makeConfig(), new AbortController().signal, {
      logger,
      runtime,
      submitter,
      source: { getLatestLedger: vi.fn(async () => ({ sequence: 200 })), getEvents },
    });

    expect(processed).toBe(1);
    expect(submit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed locally: docker is down'),
    );
  });
});

describe('main', () => {
  it('prints usage for --help', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(main({ argv: ['--help'] })).resolves.toBe(0);
      expect(out).toHaveBeenCalledWith(expect.stringContaining('pulserun-daemon'));
    } finally {
      out.mockRestore();
    }
  });

  it('prints the version for --version', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(main({ argv: ['--version'] })).resolves.toBe(0);
    } finally {
      out.mockRestore();
    }
  });

  it('fails fast on unknown arguments', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(main({ argv: ['--nope'] })).resolves.toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it('reports missing configuration instead of crashing', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(main({ argv: [], env: {}, logger: createLoggerSpy() })).resolves.toBe(1);
    } finally {
      err.mockRestore();
    }
  });

  it('stops cleanly when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const logger = createLoggerSpy();
    const env = { PULSERUN_CONTRACT_ID: CONTRACT_ID, PULSERUN_SECRET_KEY: SECRET };
    await expect(main({ argv: ['--once'], env, logger, signal: controller.signal })).resolves.toBe(
      0,
    );
  });
});

describe('config used by runDaemon', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_CONFIG.pollIntervalMs).toBe(5_000);
    expect(DEFAULT_CONFIG.jobTimeoutSeconds).toBe(900);
    expect(DEFAULT_CONFIG.allowNetwork).toBe(false);
  });
});
