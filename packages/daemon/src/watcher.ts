/**
 * Escrow event watcher.
 *
 * Polls Soroban RPC for `job_created` contract events, decodes them and keeps
 * only the jobs addressed to this runner. Events are read with a cursor so no
 * job is processed twice and none are skipped between polls.
 *
 * ## Expected contract events
 *
 * ```text
 * #[contractevent(topics = ["job_created", runner])]
 * JobCreated {
 *   job_id: u64,
 *   client: Address,
 *   image: String,
 *   cmd: String,
 *   max_budget: i128,
 *   deadline: u64,
 * }
 * ```
 *
 * The runner address is expected in `topics[1]`, but it is also accepted
 * inside the event body (`runner`) so the contract can evolve without
 * breaking older daemons.
 */

import { type rpc, type xdr, scValToNative } from '@stellar/stellar-sdk';
import { DaemonError, type Logger, silentLogger } from './config.js';

/** Name of the contract event a runner listens for. */
export const JOB_CREATED_EVENT = 'job_created';

/** Guard against a misbehaving RPC endpoint returning endless pages. */
const MAX_PAGES_PER_POLL = 20;

export interface JobCreatedEvent {
  jobId: bigint;
  client: string;
  runner: string;
  image: string;
  command: string;
  maxBudgetStroops: bigint;
  deadline: number;
  /** Ledger that emitted the event. */
  ledger: number;
  /** Transaction hash that emitted the event. */
  txHash: string;
}

/** The subset of `rpc.Server` the watcher needs, so tests can fake it. */
export interface EventSource {
  getLatestLedger(): Promise<{ sequence: number }>;
  getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
}

export interface JobWatcherOptions {
  source: EventSource;
  /** Escrow contract ID whose events are watched. */
  contractId: string;
  /** Runner public key; jobs for other runners are ignored. */
  runner: string;
  pollIntervalMs: number;
  /** Ledgers behind the head to start from when no cursor exists yet. */
  startLedgerOffset: number;
  /** Events requested per page. */
  pageLimit: number;
  logger?: Logger;
  /** Resumes from a previously persisted cursor. */
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function decodeSymbol(value: xdr.ScVal | undefined): string | null {
  if (!value) return null;
  try {
    const native = scValToNative(value);
    return typeof native === 'string' ? native : null;
  } catch {
    return null;
  }
}

function readField(source: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) return source[name];
  }
  return undefined;
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new DaemonError(`JobCreated event has a non-integer "${field}".`);
}

function asString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new DaemonError(`JobCreated event has a non-string "${field}".`);
}

/**
 * Decodes a contract event into a {@link JobCreatedEvent}.
 *
 * @returns the event, or `null` when it is not a `job_created` event. Malformed
 *   `job_created` events throw, so misconfiguration is loud instead of silent.
 */
export function decodeJobCreatedEvent(event: rpc.Api.EventResponse): JobCreatedEvent | null {
  if (decodeSymbol(event.topic[0]) !== JOB_CREATED_EVENT) return null;

  const raw = scValToNative(event.value);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DaemonError('JobCreated event payload is not a map.');
  }
  const body = raw as Record<string, unknown>;

  // The runner may live in topics[1] (preferred, indexable) or in the body.
  const runnerFromTopic = decodeSymbol(event.topic[1]);
  const runner = runnerFromTopic ?? readField(body, 'runner');
  if (typeof runner !== 'string') {
    throw new DaemonError('JobCreated event is missing the runner address.');
  }

  return {
    jobId: asBigInt(readField(body, 'job_id', 'jobId', 'id'), 'job_id'),
    client: asString(readField(body, 'client'), 'client'),
    runner,
    image: asString(readField(body, 'image'), 'image'),
    command: asString(readField(body, 'cmd', 'command'), 'cmd'),
    maxBudgetStroops: asBigInt(readField(body, 'max_budget', 'maxBudget'), 'max_budget'),
    deadline: Number(asBigInt(readField(body, 'deadline'), 'deadline')),
    ledger: event.ledger,
    txHash: event.txHash,
  };
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export class JobWatcher {
  private readonly logger: Logger;
  private cursor: string | undefined;
  private initialLedger: number | undefined;

  constructor(private readonly options: JobWatcherOptions) {
    this.logger = options.logger ?? silentLogger;
    this.cursor = options.cursor;
  }

  /** Current paging cursor, so callers can persist it across restarts. */
  get currentCursor(): string | undefined {
    return this.cursor;
  }

  /**
   * Reads every pending page once and returns the jobs addressed to this
   * runner, deduplicated and ordered by ledger.
   */
  async pollOnce(): Promise<JobCreatedEvent[]> {
    const jobs = new Map<string, JobCreatedEvent>();

    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
      const response = await this.options.source.getEvents(await this.buildRequest());
      this.cursor = response.cursor;

      for (const event of response.events) {
        const job = decodeJobCreatedEvent(event);
        if (job && job.runner === this.options.runner) {
          jobs.set(job.jobId.toString(), job);
        }
      }

      if (response.events.length < this.options.pageLimit) break;
    }

    return [...jobs.values()].sort((a, b) => a.ledger - b.ledger);
  }

  /**
   * Polls forever, invoking `handler` for each new job. Errors are logged and
   * retried on the next tick so a transient RPC outage does not kill the
   * daemon.
   */
  async run(
    handler: (job: JobCreatedEvent) => Promise<void> | void,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { signal } = options;

    while (!signal?.aborted) {
      try {
        const jobs = await this.pollOnce();
        for (const job of jobs) {
          if (signal?.aborted) return;
          await handler(job);
        }
      } catch (error) {
        if (signal?.aborted) return;
        this.logger.warn(
          `Event poll failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (signal?.aborted) return;
      await delay(this.options.pollIntervalMs, signal);
    }
  }

  private async buildRequest(): Promise<rpc.Api.GetEventsRequest> {
    const filters: rpc.Api.EventFilter[] = [
      { type: 'contract', contractIds: [this.options.contractId] },
    ];
    const limit = this.options.pageLimit;

    if (this.cursor) {
      return { filters, cursor: this.cursor, limit };
    }

    if (this.initialLedger === undefined) {
      const latest = await this.options.source.getLatestLedger();
      this.initialLedger = Math.max(1, latest.sequence - this.options.startLedgerOffset);
      this.logger.info(`Watching ${this.options.contractId} from ledger ${this.initialLedger}.`);
    }

    return { filters, startLedger: this.initialLedger, limit };
  }
}

/** Sleeps for `ms`, resolving early when the signal is aborted. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
