# Contract reference

The client targets `PulseEscrow` in
[pulserun-core](https://github.com/PulseRun-Labs/pulserun-core). All amounts are
in the `payment_token`'s base units; all times are ledger seconds. Every mutating
entrypoint returns a typed error rather than panicking.

Method names are snake_case on-chain; the client calls them verbatim.

## Writes

### `create_job(requester, runner, payment_token, max_budget, rate_per_second, max_duration_secs) -> u64`

Opens an escrow and locks collateral. Transfers `max_budget` of `payment_token`
from `requester` into the contract, then records a `Queued` job.

| Parameter           | Type      | Constraint                                    |
| ------------------- | --------- | --------------------------------------------- |
| `requester`         | `Address` | Must authorize; also the source of funds.     |
| `runner`            | `Address` | The only address allowed to submit the proof. |
| `payment_token`     | `Address` | SEP-41 token or its SAC.                      |
| `max_budget`        | `i128`    | `> 0`.                                        |
| `rate_per_second`   | `i128`    | `> 0`.                                        |
| `max_duration_secs` | `u64`     | `> 0`.                                        |

Errors: `NotInitialized`, `InvalidBudget`, `InvalidRate`, `InvalidDuration`, plus
any token-transfer failure (which reverts the call). CLI: `pulserun run`.

### `submit_proof(runner, proof: ExecutionProof) -> ()`

Records the runner's proof, locks the output hash, and starts the dispute clock.
The job must be `Queued` and the caller must be the stored runner.

| Field           | Type         | Constraint                          |
| --------------- | ------------ | ----------------------------------- |
| `job_id`        | `u64`        | An existing job.                    |
| `duration_secs` | `u64`        | `1..=max_duration_secs`.            |
| `exit_code`     | `i32`        | Recorded as reported.               |
| `output_hash`   | `BytesN<32>` | Stored on the job and in the proof. |

Errors: `JobNotFound`, `InvalidStatus`, `Unauthorized`, `InvalidDuration`,
`DurationExceedsMax`. Daemon: `RunnerEscrow.submitProof`.

### `claim_payout(job_id) -> i128`

Settles a `Completed` job after the dispute window. Pays the runner their linear
earnings (capped at `max_budget`), refunds the remainder to the requester, marks
the job `Settled`, and returns the payout. Callable by anyone. CLI:
`pulserun claim`; daemon: `RunnerEscrow.claimPayout`.

Errors: `JobNotFound`, `InvalidStatus`, `ProofNotFound`, `DisputeWindowActive`,
`MathOverflow`.

### `dispute_job(requester, job_id) -> ()`

Challenges a `Completed` proof inside the window, moving the job to `Disputed`
and halting automatic payout. CLI: `pulserun dispute`.

Errors: `JobNotFound`, `InvalidStatus`, `Unauthorized`, `DisputeWindowElapsed`,
`MathOverflow`.

### `cancel_unclaimed_job(requester, job_id) -> ()`

Refunds a still-`Queued` job in full once `max_duration_secs` has elapsed since
`created_at`, marking it `Refunded`. CLI: `pulserun cancel`.

Errors: `JobNotFound`, `InvalidStatus`, `Unauthorized`, `JobNotExpired`,
`MathOverflow`.

## Views

| Function            | Returns          | Notes                                                           |
| ------------------- | ---------------- | --------------------------------------------------------------- |
| `get_job(job_id)`   | `ComputeJob`     | `JobNotFound` if absent.                                        |
| `get_proof(job_id)` | `ExecutionProof` | `ProofNotFound` if none has landed — the client returns `null`. |
| `job_count()`       | `u64`            | Number of jobs ever created.                                    |
| `dispute_window()`  | `u64`            | Configured window, in seconds.                                  |
| `admin()`           | `Address`        | Configured administrator.                                       |

Views are read through a simulated transaction, so no signing key is required.

## Types

```ts
type JobStatus = 'Queued' | 'Completed' | 'Disputed' | 'Settled' | 'Refunded';

interface ComputeJob {
  jobId: bigint;
  requester: string;
  runner: string;
  paymentToken: string;
  maxBudget: bigint; // base units
  ratePerSecond: bigint; // base units / second
  maxDurationSecs: number;
  status: JobStatus;
  createdAt: number; // ledger seconds
  completedAt: number; // 0 until a proof lands
  outputHash: string; // 0x-prefixed; zero hash until a proof lands
}

interface ExecutionProof {
  jobId: bigint;
  durationSecs: number;
  exitCode: number;
  outputHash: Uint8Array; // 32 bytes
}
```

## Error codes

Error codes are part of the public ABI. Branch on the numeric value, not the
variant name. Codes are never renumbered.

| Code | Variant                | Meaning                                                        |
| ---- | ---------------------- | -------------------------------------------------------------- |
| 1    | `AlreadyInitialized`   | `init` was called on an initialized escrow.                    |
| 2    | `NotInitialized`       | A mutating call ran before `init`.                             |
| 3    | `JobNotFound`          | No job stored under the supplied id.                           |
| 4    | `ProofNotFound`        | No proof for a job that should have one.                       |
| 5    | `InvalidStatus`        | The job is not in the state this operation needs.              |
| 6    | `InvalidBudget`        | `max_budget` must be strictly positive.                        |
| 7    | `InvalidRate`          | `rate_per_second` must be strictly positive.                   |
| 8    | `InvalidDuration`      | A duration must be strictly positive.                          |
| 9    | `DurationExceedsMax`   | The proof claims more seconds than allowed.                    |
| 10   | `Unauthorized`         | The caller is not the address this operation is restricted to. |
| 11   | `DisputeWindowActive`  | Payout attempted while the dispute window is open.             |
| 12   | `DisputeWindowElapsed` | The challenge came after the window closed.                    |
| 13   | `JobNotExpired`        | The queued job has not passed its expiry yet.                  |
| 14   | `MathOverflow`         | A settlement computation overflowed `i128`.                    |

`ERROR_CODES` in `packages/cli/src/client/soroban.ts` mirrors this table;
`errorName(code)` resolves a number to its name.

## Events

`PulseEscrow` emits **no events** today. The daemon reconciles state by polling
`job_count` and `get_job`. Emitting `contractevent`s on each transition is a
planned pulserun-core change; when it lands, the daemon's watcher can switch from
polling to a stream without touching the executor or proof builder.
