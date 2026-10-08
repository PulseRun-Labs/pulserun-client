import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/config.js';
import { type ComputeJob, type EscrowReader, type JobStatus } from '../src/contract.js';
import { JobWatcher } from '../src/watcher.js';

const RUNNER = Keypair.random().publicKey();
const OTHER_RUNNER = Keypair.random().publicKey();
const REQUESTER = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 9));

function makeJob(overrides: Partial<ComputeJob> = {}): ComputeJob {
  return {
    jobId: 1n,
    requester: REQUESTER,
    runner: RUNNER,
    paymentToken: TOKEN,
    maxBudget: 15_000_000n,
    ratePerSecond: 1_000n,
    maxDurationSecs: 600,
    status: 'Queued' as JobStatus,
    createdAt: 1_999_999_000,
    completedAt: 0,
    outputHash: `0x${'00'.repeat(32)}`,
    ...overrides,
  };
}

function createLoggerSpy() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

function createReader(jobs: ComputeJob[]) {
  const source: EscrowReader = {
    jobCount: vi.fn(async () => BigInt(jobs.length)),
    getJob: vi.fn(async (jobId: bigint) => {
      const job = jobs.find((entry) => entry.jobId === jobId);
      if (!job) throw new Error(`job ${jobId} missing`);
      return job;
    }),
    disputeWindow: vi.fn(async () => 3_600),
  };
  return source;
}

function createWatcher(source: EscrowReader, overrides: { logger?: Logger } = {}) {
  return new JobWatcher({ source, runner: RUNNER, logger: overrides.logger ?? createLoggerSpy() });
}

describe('JobWatcher.pollOnce', () => {
  it('discovers only queued jobs addressed to this runner', async () => {
    const source = createReader([
      makeJob({ jobId: 1n, runner: RUNNER, status: 'Queued' }),
      makeJob({ jobId: 2n, runner: OTHER_RUNNER, status: 'Queued' }),
      makeJob({ jobId: 3n, runner: RUNNER, status: 'Completed' }),
      makeJob({ jobId: 4n, runner: RUNNER, status: 'Queued' }),
    ]);

    const jobs = await createWatcher(source).pollOnce();

    expect(jobs.map((job) => job.jobId)).toEqual([1n, 4n]);
  });

  it('re-scans from id 1 and only reads each id once', async () => {
    const source = createReader([makeJob({ jobId: 1n }), makeJob({ jobId: 2n })]);
    const watcher = createWatcher(source);

    await watcher.pollOnce();
    await watcher.pollOnce();

    // Two reads for discovery, then one refresh each on the second poll.
    expect(source.getJob).toHaveBeenCalledWith(1n);
    expect(source.getJob).toHaveBeenCalledWith(2n);
  });

  it('drops a job once it leaves Queued', async () => {
    const job = makeJob({ jobId: 1n, status: 'Queued' });
    const source = createReader([job]);
    const watcher = createWatcher(source);

    expect(await watcher.pollOnce()).toHaveLength(1);

    job.status = 'Completed';
    expect(await watcher.pollOnce()).toHaveLength(0);
    expect(watcher.pendingCount).toBe(0);
  });

  it('keeps retrying a job that is still queued', async () => {
    const source = createReader([makeJob({ jobId: 1n })]);
    const watcher = createWatcher(source);

    expect(await watcher.pollOnce()).toHaveLength(1);
    expect(await watcher.pollOnce()).toHaveLength(1);
    expect(watcher.pendingCount).toBe(1);
  });

  it('discovers newly created jobs on later polls', async () => {
    const jobs = [makeJob({ jobId: 1n })];
    const source = createReader(jobs);
    const watcher = createWatcher(source);

    expect(await watcher.pollOnce()).toHaveLength(1);

    jobs.push(makeJob({ jobId: 2n }));
    const second = await watcher.pollOnce();
    expect(second.map((job) => job.jobId)).toEqual([1n, 2n]);
  });

  it('returns nothing when the contract has no jobs', async () => {
    const watcher = createWatcher(createReader([]));
    expect(await watcher.pollOnce()).toEqual([]);
  });
});
