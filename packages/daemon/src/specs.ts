/**
 * Job specs.
 *
 * `PulseEscrow.create_job` pins the money and the parties but not the command
 * line, so the runner needs the job's image and command out of band. Until
 * pulserun-core lands an on-chain metadata hash, the daemon reads them from a
 * JSON file keyed by job id:
 *
 * ```json
 * { "42": { "image": "node:22-alpine", "command": "pnpm test" } }
 * ```
 *
 * A requester can write this file with `pulserun run --spec-out`, and a runner
 * on the same host reads it. Without a spec the runner never invents a command:
 * it logs and leaves the job to retry or expire.
 */

import { readFile } from 'node:fs/promises';
import { DaemonError, type Logger, silentLogger } from './config.js';

export interface JobSpec {
  image: string;
  command: string;
}

/** Resolves the image/command for a job id, or `null` when none is recorded. */
export interface JobSpecStore {
  get(jobId: bigint): Promise<JobSpec | null>;
}

export interface FileJobSpecStoreOptions {
  path: string;
  logger?: Logger;
}

/** Reads job specs from a JSON file, re-reading on every lookup. */
export class FileJobSpecStore implements JobSpecStore {
  private readonly path: string;
  private readonly logger: Logger;

  constructor(options: FileJobSpecStoreOptions) {
    this.path = options.path;
    this.logger = options.logger ?? silentLogger;
  }

  async get(jobId: bigint): Promise<JobSpec | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug(`Job spec file ${this.path} does not exist yet.`);
        return null;
      }
      throw new DaemonError(`Could not read job spec file "${this.path}".`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new DaemonError(`Job spec file "${this.path}" is not valid JSON.`, { cause: error });
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DaemonError(`Job spec file "${this.path}" must contain a JSON object.`);
    }

    const entry = (parsed as Record<string, unknown>)[jobId.toString()];
    if (entry === undefined || entry === null) return null;
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DaemonError(`Job spec for #${jobId} must be an object.`);
    }

    const { image, command } = entry as Record<string, unknown>;
    if (typeof image !== 'string' || image.trim() === '') {
      throw new DaemonError(`Job spec for #${jobId} is missing a non-empty "image".`);
    }
    if (typeof command !== 'string' || command.trim() === '') {
      throw new DaemonError(`Job spec for #${jobId} is missing a non-empty "command".`);
    }

    return { image: image.trim(), command: command.trim() };
  }
}
