/**
 * Job specs.
 *
 * `PulseEscrow.create_job` pins the money and the parties but not the command
 * line, so the runner needs the job's image and command out of band. Until
 * pulserun-core lands an on-chain metadata hash, the daemon reads them from a
 * JSON file keyed by job id:
 *
 * ```json
 * {
 *   "42": {
 *     "image": "node:22-alpine",
 *     "command": "pnpm test",
 *     "signer": "GABC…",
 *     "signature": "base64…"
 *   }
 * }
 * ```
 *
 * The signature is not optional. Anyone who can write that file could otherwise
 * choose what a runner executes under another party's escrow, so the daemon
 * only runs a spec signed by the job's on-chain requester. `pulserun run
 * --spec-out` writes the signature; {@link verifyJobSpecSignature} checks it.
 */

import { readFile } from 'node:fs/promises';
import { Keypair } from '@stellar/stellar-sdk';
import { DaemonError, type Logger, silentLogger } from './config.js';

/** Domain separator; must match `@pulserun/cli`'s `JOB_SPEC_DOMAIN`. */
export const JOB_SPEC_DOMAIN = 'pulserun-job-spec';

/** Format version; must match `@pulserun/cli`'s `JOB_SPEC_VERSION`. */
export const JOB_SPEC_VERSION = 1;

export interface JobSpec {
  image: string;
  command: string;
  /** Requester address that signed the spec, when a signature is present. */
  signer?: string;
  /** Base64 Ed25519 signature over {@link jobSpecMessage}. */
  signature?: string;
}

export interface JobSpecContent {
  jobId: bigint | number | string;
  requester: string;
  image: string;
  command: string;
}

/**
 * Builds the canonical message a requester signs for a job spec.
 *
 * Byte-for-byte identical to the CLI's verifier-side implementation; both
 * test suites assert the same literal string so the format cannot drift.
 */
export function jobSpecMessage(content: JobSpecContent): string {
  return JSON.stringify({
    domain: JOB_SPEC_DOMAIN,
    version: JOB_SPEC_VERSION,
    jobId: String(content.jobId),
    requester: content.requester,
    image: content.image,
    command: content.command,
  });
}

/**
 * True when `spec` carries a valid signature from the job's requester.
 *
 * Returns `false` rather than throwing so the daemon can skip a bad spec with a
 * clear log line instead of crashing the poll loop. A malformed address or
 * signature is a rejection, never an excuse to run the command.
 */
export function verifyJobSpecSignature(
  job: { jobId: bigint; requester: string },
  spec: Pick<JobSpec, 'image' | 'command' | 'signer' | 'signature'>,
): boolean {
  if (!spec.signer || !spec.signature) return false;
  // The signature only means anything if the key is the party that funded the
  // escrow; a self-signed spec by anyone else proves nothing.
  if (spec.signer !== job.requester) return false;

  try {
    const keypair = Keypair.fromPublicKey(job.requester);
    const message = Buffer.from(
      jobSpecMessage({
        jobId: job.jobId,
        requester: job.requester,
        image: spec.image,
        command: spec.command,
      }),
      'utf8',
    );
    return keypair.verify(message, Buffer.from(spec.signature, 'base64'));
  } catch {
    // Malformed address or signature: treat as unsigned, never as trusted.
    return false;
  }
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

    const { image, command, signer, signature } = entry as Record<string, unknown>;
    if (typeof image !== 'string' || image.trim() === '') {
      throw new DaemonError(`Job spec for #${jobId} is missing a non-empty "image".`);
    }
    if (typeof command !== 'string' || command.trim() === '') {
      throw new DaemonError(`Job spec for #${jobId} is missing a non-empty "command".`);
    }
    if (signer !== undefined && typeof signer !== 'string') {
      throw new DaemonError(`Job spec for #${jobId} has a non-string "signer".`);
    }
    if (signature !== undefined && typeof signature !== 'string') {
      throw new DaemonError(`Job spec for #${jobId} has a non-string "signature".`);
    }

    const spec: JobSpec = { image: image.trim(), command: command.trim() };
    if (signer) spec.signer = signer.trim();
    if (signature) spec.signature = signature.trim();
    return spec;
  }
}
