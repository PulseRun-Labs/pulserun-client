import { Address, Keypair, StrKey, type rpc, nativeToScVal } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/config.js';
import {
  JOB_CREATED_EVENT,
  type JobCreatedEvent,
  JobWatcher,
  decodeJobCreatedEvent,
} from '../src/watcher.js';

const RUNNER = Keypair.random().publicKey();
const OTHER_RUNNER = Keypair.random().publicKey();
const CLIENT = Keypair.random().publicKey();
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 9));

const DEFAULT_BODY: Record<string, unknown> = {
  job_id: 5n,
  client: CLIENT,
  image: 'node:22-alpine',
  cmd: 'pnpm test',
  max_budget: 15_000_000n,
  deadline: 2_000_000_000n,
};

interface EventOptions {
  name?: string;
  runner?: string;
  body?: Record<string, unknown>;
  ledger?: number;
  withRunnerTopic?: boolean;
  txHash?: string;
}

function makeEvent(options: EventOptions = {}): rpc.Api.EventResponse {
  const runner = options.runner ?? RUNNER;
  const topic = [nativeToScVal(options.name ?? JOB_CREATED_EVENT, { type: 'symbol' })];
  if (options.withRunnerTopic !== false) topic.push(new Address(runner).toScVal());

  return {
    id: `event-${options.ledger ?? 100}`,
    type: 'contract',
    ledger: options.ledger ?? 100,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: options.txHash ?? 'a'.repeat(64),
    topic,
    value: nativeToScVal(options.body ?? DEFAULT_BODY),
  } as unknown as rpc.Api.EventResponse;
}

function response(events: rpc.Api.EventResponse[], cursor: string): rpc.Api.GetEventsResponse {
  return {
    events,
    cursor,
    latestLedger: 1_000,
    oldestLedger: 1,
    latestLedgerCloseTime: '2026-01-01T00:00:00Z',
    oldestLedgerCloseTime: '2026-01-01T00:00:00Z',
  };
}

function createLoggerSpy() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

function createWatcher(
  responses: rpc.Api.GetEventsResponse[],
  overrides: Partial<ConstructorParameters<typeof JobWatcher>[0]> = {},
  latestLedger = 5_000,
) {
  const getEvents = vi.fn(async () => responses.shift() ?? response([], 'cursor-end'));
  const getLatestLedger = vi.fn(async () => ({ sequence: latestLedger }));
  const logger = overrides.logger ?? createLoggerSpy();

  const watcher = new JobWatcher({
    source: { getEvents, getLatestLedger },
    contractId: CONTRACT_ID,
    runner: RUNNER,
    pollIntervalMs: 1,
    startLedgerOffset: 100,
    pageLimit: 10,
    logger,
    ...overrides,
  });

  return { watcher, getEvents, getLatestLedger, logger };
}

describe('decodeJobCreatedEvent', () => {
  it('decodes a job addressed to the runner', () => {
    const job = decodeJobCreatedEvent(makeEvent({ ledger: 123 }));

    expect(job).toMatchObject({
      jobId: 5n,
      client: CLIENT,
      runner: RUNNER,
      image: 'node:22-alpine',
      command: 'pnpm test',
      maxBudgetStroops: 15_000_000n,
      deadline: 2_000_000_000,
      ledger: 123,
      txHash: 'a'.repeat(64),
    });
  });

  it('ignores unrelated contract events', () => {
    expect(decodeJobCreatedEvent(makeEvent({ name: 'job_cancelled' }))).toBeNull();
  });

  it('accepts the runner inside the event body', () => {
    const job = decodeJobCreatedEvent(
      makeEvent({ withRunnerTopic: false, body: { ...DEFAULT_BODY, runner: OTHER_RUNNER } }),
    );
    expect(job?.runner).toBe(OTHER_RUNNER);
  });

  it('prefers the indexed runner topic over the body', () => {
    const job = decodeJobCreatedEvent(
      makeEvent({ runner: RUNNER, body: { ...DEFAULT_BODY, runner: OTHER_RUNNER } }),
    );
    expect(job?.runner).toBe(RUNNER);
  });

  it('rejects a payload that is not a map', () => {
    const event = {
      ...makeEvent(),
      value: nativeToScVal('nope', { type: 'string' }),
    } as unknown as rpc.Api.EventResponse;
    expect(() => decodeJobCreatedEvent(event)).toThrowError(/not a map/);
  });

  it('rejects a job_created event without a runner', () => {
    expect(() =>
      decodeJobCreatedEvent(makeEvent({ withRunnerTopic: false, body: { ...DEFAULT_BODY } })),
    ).toThrowError(/missing the runner address/);
  });

  it('rejects non-integer and non-string fields', () => {
    expect(() =>
      decodeJobCreatedEvent(makeEvent({ body: { ...DEFAULT_BODY, job_id: 'abc' } })),
    ).toThrowError(/non-integer "job_id"/);
    expect(() =>
      decodeJobCreatedEvent(makeEvent({ body: { ...DEFAULT_BODY, image: 42 } })),
    ).toThrowError(/non-string "image"/);
  });
});

describe('JobWatcher.pollOnce', () => {
  it('starts from head minus the configured offset on the first poll', async () => {
    const { watcher, getEvents, getLatestLedger } = createWatcher(
      [response([], 'c1')],
      {
        startLedgerOffset: 100,
      },
      5_000,
    );

    await watcher.pollOnce();

    expect(getLatestLedger).toHaveBeenCalledOnce();
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 4_900, limit: 10 }),
    );
  });

  it('resumes from the stored cursor afterwards', async () => {
    const { watcher, getEvents, getLatestLedger } = createWatcher([
      response([], 'cursor-1'),
      response([], 'cursor-2'),
    ]);

    await watcher.pollOnce();
    await watcher.pollOnce();

    expect(getLatestLedger).toHaveBeenCalledOnce();
    expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-1', limit: 10 }),
    );
    expect(watcher.currentCursor).toBe('cursor-2');
  });

  it('keeps only jobs addressed to this runner', async () => {
    const { watcher } = createWatcher([
      response(
        [
          makeEvent({ ledger: 10, txHash: 'mine' }),
          makeEvent({ ledger: 11, runner: OTHER_RUNNER }),
          makeEvent({ ledger: 12, name: 'job_completed' }),
        ],
        'c1',
      ),
    ]);

    const jobs = await watcher.pollOnce();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.txHash).toBe('mine');
  });

  it('deduplicates a job seen in more than one page', async () => {
    const { watcher } = createWatcher(
      [response([makeEvent({ ledger: 10 }), makeEvent({ ledger: 10 })], 'c1'), response([], 'c2')],
      { pageLimit: 2 },
    );

    const jobs = await watcher.pollOnce();
    expect(jobs).toHaveLength(1);
  });

  it('pages until a short page is returned', async () => {
    const job = (jobId: bigint, ledger: number) =>
      makeEvent({ ledger, body: { ...DEFAULT_BODY, job_id: jobId } });
    const { watcher, getEvents } = createWatcher(
      [response([job(1n, 10), job(2n, 11)], 'c1'), response([job(3n, 12)], 'c2')],
      { pageLimit: 2 },
    );

    const jobs = await watcher.pollOnce();

    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(jobs.map((entry) => entry.jobId)).toEqual([1n, 2n, 3n]);
  });

  it('propagates decode errors so misconfiguration is loud', async () => {
    const { watcher } = createWatcher([
      response([makeEvent({ body: { ...DEFAULT_BODY, job_id: 'nope' } })], 'c1'),
    ]);
    await expect(watcher.pollOnce()).rejects.toThrowError(/non-integer "job_id"/);
  });
});

describe('JobWatcher.run', () => {
  it('returns immediately when the signal is already aborted', async () => {
    const { watcher, getEvents } = createWatcher([]);
    const controller = new AbortController();
    controller.abort();

    await watcher.run(() => {}, { signal: controller.signal });
    expect(getEvents).not.toHaveBeenCalled();
  });

  it('invokes the handler and stops when aborted', async () => {
    const { watcher } = createWatcher([response([makeEvent()], 'c1')]);
    const controller = new AbortController();
    const handled = vi.fn(async (_job: JobCreatedEvent) => {
      controller.abort();
    });

    await watcher.run(handled, { signal: controller.signal });

    expect(handled).toHaveBeenCalledOnce();
    expect(handled.mock.calls[0]?.[0]).toMatchObject({ jobId: 5n });
  });

  it('logs and retries after a transient RPC failure', async () => {
    const logger = createLoggerSpy();
    let calls = 0;
    const getEvents = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('rpc down');
      return response([makeEvent()], 'c1');
    });

    const controller = new AbortController();
    const watcher = new JobWatcher({
      source: { getEvents, getLatestLedger: vi.fn(async () => ({ sequence: 1 })) },
      contractId: CONTRACT_ID,
      runner: RUNNER,
      pollIntervalMs: 1,
      startLedgerOffset: 0,
      pageLimit: 10,
      logger,
    });

    await watcher.run(
      () => {
        controller.abort();
      },
      { signal: controller.signal },
    );

    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Event poll failed: rpc down'),
    );
  });
});
