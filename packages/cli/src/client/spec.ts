/**
 * Authenticated job specs.
 *
 * `PulseEscrow.create_job` pins the money and the parties but not the command
 * line, so a runner still needs the job's image and command out of band. A
 * plain local file would let anyone who can write it decide what a runner
 * executes under someone else's escrow, so the requester signs the spec with
 * the same key that authorized `create_job`. The daemon verifies the signature
 * against `job.requester` before it pulls an image.
 *
 * Canonical message — UTF-8, one line, no trailing newline:
 *
 * ```json
 * {"domain":"pulserun-job-spec","version":1,"jobId":"42","requester":"G...","image":"node:22-alpine","command":"pnpm test"}
 * ```
 *
 * The keys and their order are fixed, and `JSON.stringify` escapes any quote or
 * newline inside `command`, so the message is unambiguous. A worker in another
 * language can reproduce it with the same four fields.
 */

import type { Keypair } from '@stellar/stellar-sdk';
import { PulseRunError } from './soroban.js';

/** Domain separator, so a spec signature can never be replayed as a transaction. */
export const JOB_SPEC_DOMAIN = 'pulserun-job-spec';

/** Format version; bump only if the canonical message changes. */
export const JOB_SPEC_VERSION = 1;

/** Fields that identify the spec being signed. */
export interface JobSpecContent {
  /** Id assigned by `create_job`; binds the signature to one escrow. */
  jobId: bigint | number | string;
  /** Address that funded the escrow; also the signer. */
  requester: string;
  image: string;
  command: string;
}

/** Detached signature stored next to the spec. */
export interface JobSpecSignature {
  /** Address that signed the spec; must equal the job's on-chain requester. */
  signer: string;
  /** Base64 Ed25519 signature over {@link jobSpecMessage}. */
  signature: string;
}

/**
 * Builds the exact bytes a requester signs for a job spec.
 *
 * Kept byte-for-byte identical to the daemon's verifier; both packages assert
 * the same literal message in their suites so the two cannot drift silently.
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
 * Signs a job spec with the requester's key.
 *
 * @throws {PulseRunError} when the key does not match `content.requester`; a
 *   runner would reject such a signature anyway.
 */
export function signJobSpec(keypair: Keypair, content: JobSpecContent): JobSpecSignature {
  const signer = keypair.publicKey();
  if (signer !== content.requester) {
    throw new PulseRunError(
      `Refusing to sign the job spec: ${signer} is not the job's requester ${content.requester}.`,
    );
  }
  // `Keypair.sign` returns a Uint8Array, so re-wrap it before base64 encoding.
  const signature = Buffer.from(
    keypair.sign(Buffer.from(jobSpecMessage(content), 'utf8')),
  ).toString('base64');
  return { signer, signature };
}
