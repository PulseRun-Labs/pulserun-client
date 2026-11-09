# Verifying a proof

The escrow records a runner's proof, but a digest on-chain is only useful if
someone can check it. `pulserun-verify` is that third role: it does not fund the
job and does not run it for pay — it re-runs the job and compares the result
with what the contract recorded.

## What it checks

```text
expected_hash = get_proof(job_id).output_hash        (BytesN<32>)
actual_hash   = SHA-256(sandbox stdout + stderr)
expected_exit = get_proof(job_id).exit_code
actual_exit   = container exit code (124 on timeout)
verified      = expected_hash == actual_hash && expected_exit == actual_exit
```

Duration is deliberately **not** compared. `duration_secs` is the runner's
metered wall-clock time and does not reproduce across machines; the contract
uses it for billing, not for correctness. A verifier therefore checks _what_
ran and _whether it succeeded_, not _how long the runner claims it took_.

## Requirements

- Node.js >= 22.12.0 and a built workspace (`pnpm build`).
- Docker reachable through `PULSERUN_DOCKER_HOST`.
- Soroban RPC access to the network holding the job.
- **No Stellar secret key.** Verification is read-only.

```bash
export PULSEESCROW_ID=C...
export PULSERUN_NETWORK=testnet
export PULSERUN_JOB_SPECS_FILE=./jobs.json

pulserun-verify 42
pulserun-verify 42 --json          # machine-readable verdict
```

## Where the command comes from

The contract does not store the command line, so the verifier needs a spec. It
takes one of two paths:

1. **The requester-signed spec (default).** The entry in the spec file is only
   used when its signature verifies against `job.requester` and its canonical
   message binds the job id, image and command. An unsigned or foreign-signed
   entry is refused — the verifier will not execute a command nobody authorized.
2. **`--image` and `--cmd` together.** An operator supplying the workload
   explicitly. The command prints a warning because there is no signature to
   check; use this only when you already know the spec from another source.

The canonical signed message is:

```text
{"domain":"pulserun-job-spec","version":1,"jobId":"42","requester":"G…","image":"node:22-alpine","command":"pnpm test"}
```

Fixed key order, UTF-8, one line, no trailing newline. `JSON.stringify` escaping
keeps a quote or newline inside `command` from forging another field.

## Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | The re-run reproduced the on-chain digest and exit code.               |
| `1`  | The re-run completed but produced a different digest or exit code.     |
| `2`  | Verification could not run: no proof, bad spec, Docker or RPC failure. |

`--json` emits the same verdict:

```json
{
  "jobId": "42",
  "verified": false,
  "expected": { "outputHash": "0x9f2c…", "exitCode": 0, "durationSecs": 20 },
  "actual": {
    "outputHash": "1b7e…",
    "exitCode": 0,
    "durationMs": 12400,
    "timedOut": false,
    "logBytes": 1834
  },
  "reasons": ["output hash does not match the on-chain proof"]
}
```

## Making a job reproducible

Verification is only meaningful for deterministic workloads. To make a job
verifiable:

- **Pin the image by digest** (`node@sha256:…`), not by tag. A tag can move
  between the run and the verification.
- **Remove nondeterminism** — clocks, random IDs, parallel test ordering,
  locale-dependent output and timestamps written by the workload all change the
  digest.
- **Keep the sandbox configuration equal.** `PULSERUN_ALLOW_NETWORK`,
  `PULSERUN_CPU_LIMIT`, `PULSERUN_MEMORY_LIMIT_MB`, `PULSERUN_PIDS_LIMIT` and
  `PULSERUN_JOB_TIMEOUT_SECONDS` must match the runner's values; the verifier
  applies the same limits but cannot detect a mismatch.
- **Remember that output is hashed verbatim.** A progress bar or colour code
  emitted on one machine but not another is enough to differ.

A non-reproducible job is not evidence of fraud. The verdict says the proof was
not reproducible _here_, which is why `1` is distinct from an error and from an
on-chain dispute. A dispute still requires a human decision; this command gives
that decision evidence instead of a hunch.

## Trust boundaries

- The verifier trusts the Soroban RPC response for `get_job` / `get_proof`. Use
  an RPC endpoint you trust, or one whose responses you can cross-check.
- The verifier trusts the local Docker daemon to run the image it asks for.
- The verifier does not prove the runner used the same _machine_; it proves the
  workload can produce the same bytes. That is the property the protocol relies
  on.
