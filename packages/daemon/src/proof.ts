/**
 * Execution proofs.
 *
 * A runner never uploads logs on-chain. It hashes the sandbox output with
 * SHA-256 and submits an `ExecutionProof { job_id, duration_secs, exit_code,
 * output_hash }` to the escrow, which meters the run and settles it. Anyone can
 * later re-run the job and compare hashes.
 *
 * ```text
 * submit_proof(runner: Address, proof: ExecutionProof) -> ()
 * ExecutionProof { job_id: u64, duration_secs: u64, exit_code: i32, output_hash: BytesN<32> }
 * ```
 */

import { createHash } from 'node:crypto';
import { DaemonError } from './config.js';

/** Hash function used for output hashes; part of the on-chain ABI. */
export const PROOF_HASH_ALGORITHM = 'sha256';

/** Length of a SHA-256 digest in bytes (`BytesN<32>` on-chain). */
export const OUTPUT_HASH_BYTES = 32;

/** Conventional exit code reported when a sandbox hit its wall-clock limit. */
export const TIMEOUT_EXIT_CODE = 124;

/** Hashes sandbox output into a lowercase, unprefixed hex digest. */
export function hashLogs(logs: string | Uint8Array): string {
  return createHash(PROOF_HASH_ALGORITHM).update(logs).digest('hex');
}

/** Hashes sandbox output into the raw 32 bytes the contract expects. */
export function outputHashBytes(logs: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash(PROOF_HASH_ALGORITHM).update(logs).digest());
}

/** Normalises a hex digest (`0x…` or bare) to lowercase, unprefixed hex. */
export function normaliseHash(hash: string): string {
  const value = hash.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new DaemonError(`"${hash}" is not a 32-byte SHA-256 hex digest.`);
  }
  return value;
}

/** Converts a hex digest into the raw bytes sent to the contract. */
export function hexToBytes(hash: string): Uint8Array {
  return new Uint8Array(Buffer.from(normaliseHash(hash), 'hex'));
}

export interface ExecutionOutcome {
  exitCode: number;
  logs: string | Uint8Array;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number;
  /** True when the sandbox was killed because it exceeded its deadline. */
  timedOut?: boolean;
}

export interface ExecutionProof {
  /** Lowercase hex SHA-256 of the sandbox output. */
  outputHash: string;
  /** Billable seconds reported on-chain (`>= 1`). */
  durationSecs: number;
  exitCode: number;
}

/**
 * Builds the proof payload for a finished sandbox run.
 *
 * The metered duration is rounded up to whole seconds and floored at one,
 * because the contract rejects a zero-second proof.
 */
export function buildProof(outcome: ExecutionOutcome): ExecutionProof {
  const timedOut = outcome.timedOut ?? false;
  return {
    outputHash: hashLogs(outcome.logs),
    durationSecs: Math.max(1, Math.ceil(outcome.durationMs / 1000)),
    exitCode: timedOut ? TIMEOUT_EXIT_CODE : outcome.exitCode,
  };
}

/** Formats a proof for logs: `#12 sha256:abcd… 20s exit 0`. */
export function formatProof(jobId: bigint, proof: ExecutionProof): string {
  return `#${jobId} sha256:${proof.outputHash.slice(0, 12)}… ${proof.durationSecs}s exit ${proof.exitCode}`;
}
