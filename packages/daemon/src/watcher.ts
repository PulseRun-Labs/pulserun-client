/**
 * Job watcher.
 *
 * The PulseEscrow contract emits no events yet (pulserun-core tracks that as
 * planned work), so the runner cannot subscribe. Instead the daemon polls
 * `job_count` and `get_job`, keeping only jobs addressed to this runner that
 * are still `Queued`. Newly created jobs are discovered by id; jobs already
 * discovered are re-checked each poll so a local execution failure is retried
 * (or the job expires and the requester refunds) rather than being lost.
 */

import { type ComputeJob, type EscrowReader } from './contract.js';
import { type Logger, silentLogger } from './config.js';

export interface JobWatcherOptions {
  source: EscrowReader;
  /** Runner public key; jobs addressed to other runners are ignored. */
  runner: string;
  logger?: Logger;
}

export class JobWatcher {
  private readonly logger: Logger;
  /** Next job id to discover (ids are assigned monotonically from 1). */
  private nextId = 1n;
  /** Jobs addressed to this runner that are still awaiting a proof. */
  private readonly pending = new Map<string, ComputeJob>();

  constructor(private readonly options: JobWatcherOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /** Jobs currently known to be queued for this runner. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Reads once: discovers new jobs up to `job_count` and refreshes every
   * pending job. Returns the jobs that are still `Queued` for this runner.
   */
  async pollOnce(): Promise<ComputeJob[]> {
    const count = await this.options.source.jobCount();

    while (this.nextId <= count) {
      const job = await this.options.source.getJob(this.nextId);
      if (job.runner === this.options.runner && job.status === 'Queued') {
        this.logger.debug(`Job #${job.jobId} queued for this runner.`);
        this.pending.set(job.jobId.toString(), job);
      }
      this.nextId += 1n;
    }

    const open: ComputeJob[] = [];
    for (const key of [...this.pending.keys()]) {
      const job = await this.options.source.getJob(BigInt(key));
      if (job.status !== 'Queued') {
        this.pending.delete(key);
        continue;
      }
      this.pending.set(key, job);
      open.push(job);
    }

    return open;
  }
}
