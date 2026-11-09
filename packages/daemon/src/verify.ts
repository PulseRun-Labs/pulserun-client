/**
 * Independent verification of an execution proof.
 *
 * A runner's proof is a SHA-256 digest of the sandbox output plus the metered
 * duration and exit code. Until now nothing in this repository could check
 * that claim: the contract stores the digest, but the requester had to trust
 * it. `pulserun-verify` closes that loop by re-running the same image and
 * command in a sandbox with the same limits and comparing the digest it gets
 * with the one recorded on-chain.
 *
 * ```text
 * expected = get_proof(job_id).output_hash
 * actual   = sha256(sandbox stdout + stderr)
 * verified = actual == expected && exit codes agree
 * ```
 *
 * Duration is *not* compared: it is the runner's metered wall-clock time and
 * will differ between machines. Reproducibility also requires a deterministic
 * workload — same image digest, same inputs, no clocks, randomness or network.
 * A mismatch therefore means "could not reproduce", which is why the command
 * exits `1` rather than claiming fraud.
 */

import type { ComputeJob, ExecutionProofRecord } from './contract.js';
import type { DockerExecutor } from './executor.js';
import { hashLogs, normaliseHash } from './proof.js';
import type { JobSpec } from './specs.js';

export interface VerificationInput {
  job: ComputeJob;
  proof: ExecutionProofRecord;
  spec: JobSpec;
  /** Wall-clock budget for the re-run, in seconds. */
  timeoutSeconds: number;
}

export interface VerificationResult {
  jobId: bigint;
  verified: boolean;
  /** What the contract recorded. */
  expected: {
    outputHash: string;
    exitCode: number;
    durationSecs: number;
  };
  /** What this machine reproduced. */
  actual: {
    outputHash: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
    logBytes: number;
  };
  /** Empty when verified; otherwise why the re-run did not match. */
  reasons: string[];
}

export interface VerifyExecutionDependencies {
  executor: Pick<DockerExecutor, 'execute'>;
}

/** Prepends `sha256:` and truncates a digest for terminal output. */
export function shortDigest(hash: string): string {
  const bare = hash.trim().toLowerCase().replace(/^0x/, '');
  return `sha256:${bare.slice(0, 12)}…`;
}

/**
 * Re-runs a proved job and compares the result with the on-chain proof.
 *
 * @throws {DaemonError} when the sandbox cannot run at all (Docker down, image
 *   missing). A reproducible-but-different result is *not* an error: it comes
 *   back as `verified: false` with reasons.
 */
export async function verifyExecution(
  input: VerificationInput,
  deps: VerifyExecutionDependencies,
): Promise<VerificationResult> {
  const run = await deps.executor.execute({
    jobId: input.job.jobId,
    image: input.spec.image,
    command: input.spec.command,
    timeoutSeconds: input.timeoutSeconds,
  });

  const actualHash = hashLogs(run.logs);
  const expectedHash = normaliseHash(input.proof.outputHash);
  const reasons: string[] = [];

  if (actualHash !== expectedHash) {
    reasons.push('output hash does not match the on-chain proof');
  }
  if (run.exitCode !== input.proof.exitCode) {
    reasons.push(`exit code ${run.exitCode} does not match on-chain ${input.proof.exitCode}`);
  }
  if (run.timedOut) {
    reasons.push(`sandbox hit the ${input.timeoutSeconds}s verification timeout (exit 124)`);
  }

  return {
    jobId: input.job.jobId,
    verified: reasons.length === 0,
    expected: {
      outputHash: input.proof.outputHash,
      exitCode: input.proof.exitCode,
      durationSecs: input.proof.durationSecs,
    },
    actual: {
      outputHash: actualHash,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      logBytes: Buffer.byteLength(run.logs, 'utf8'),
    },
    reasons,
  };
}

/** Process exit code for a finished verification: `0` matches, `1` does not. */
export function verificationExitCode(result: VerificationResult): number {
  return result.verified ? 0 : 1;
}

/** Renders the verdict body as aligned, human-readable lines (header excluded). */
export function formatVerification(result: VerificationResult): string {
  const seconds = (result.actual.durationMs / 1000).toFixed(1);
  const rows: Array<[string, string]> = [
    ['Expected', `${shortDigest(result.expected.outputHash)} exit ${result.expected.exitCode}`],
    [
      'Reproduced',
      `${shortDigest(result.actual.outputHash)} exit ${result.actual.exitCode} ` +
        `(${seconds}s, ${result.actual.logBytes} bytes of output)`,
    ],
    ['Proof time', `${result.expected.durationSecs}s metered by the runner (not compared)`],
  ];
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  const lines = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
  if (result.verified) {
    lines.push('Result: verified — the re-run reproduced the on-chain digest.');
  } else {
    lines.push('Result: not reproduced');
    for (const reason of result.reasons) lines.push(`  - ${reason}`);
  }
  return lines.join('\n');
}

/** Projects a verification result into JSON-friendly output. */
export function verificationToJson(result: VerificationResult) {
  return {
    jobId: result.jobId.toString(),
    verified: result.verified,
    expected: result.expected,
    actual: result.actual,
    reasons: result.reasons,
  };
}
