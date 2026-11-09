# Architecture

PulseRun is split into two repositories so each concern can be reviewed and
supported independently.

- **`pulserun-core`** — a pure Rust workspace. `PulseEscrow` holds and settles
  funds; `mock_token` exists only to exercise settlement in tests. No application
  code.
- **`pulserun-client`** (this repo) — the application layer. A TypeScript
  workspace with a requester CLI, a runner daemon and a read-only proof
  verifier.

## How they connect

The client builds and signs Soroban transactions against the deployed
`PulseEscrow` contract id. It restates the escrow's `ComputeJob` /
`ExecutionProof` types and error codes so the two repos agree at the ABI
boundary. Contract ids are passed at runtime through environment variables
(`PULSEESCROW_ID`, `MOCKTOKEN_ID`) — never guessed or hard-coded.

```text
┌──────────────────────┐        Soroban RPC        ┌──────────────────────┐
│  @pulserun/cli       │ ────────────────────────► │  PulseEscrow         │
│  create_job          │                           │  (pulserun-core)     │
│  get_job / get_proof │ ◄──────────────────────── │                      │
│  dispute / cancel    │                           │                      │
│  claim_payout        │                           │                      │
└──────────────────────┘                           └──────────────────────┘
                                                       ▲          │
┌──────────────────────┐        Soroban RPC            │          │ transfer
│  @pulserun/daemon    │ ──────────────────────────────┘          │
│  watcher → executor  │                                          ▼
│  → proof → claim     │                            ┌──────────────────────┐
└──────────────────────┘                            │  payment_token       │
        │  docker run                               │  (SEP-41 / SAC)      │
        ▼                                           └──────────────────────┘
┌──────────────────────┐
│  sandbox (isolated)  │ ◄──── re-run ──── ┌──────────────────────┐
└──────────────────────┘                   │  pulserun-verify     │
                                           │  get_job/get_proof   │
                                           └──────────────────────┘
```

## CLI modules

| Module                  | Responsibility                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `src/index.ts`          | commander program; maps thrown errors to exit codes.                                     |
| `src/config.ts`         | flag + env resolution, network presets, amount/decimals parsing.                         |
| `src/ui.ts`             | colour, tables, durations, address shortening.                                           |
| `src/client/soroban.ts` | typed `PulseEscrow` client: encoding, decoding, error codes, writes and simulated reads. |
| `src/commands/*`        | one file per command surface (`run`, `status`, `lifecycle`).                             |

The client keeps Soroban behind `SorobanRpcServer` (a narrow slice of
`rpc.Server`), so every command is testable with a fake and never needs a live
network.

## Daemon modules

| Module              | Responsibility                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/index.ts`      | the runner loop: poll → execute → prove → claim, with a concurrency limiter.                          |
| `src/watcher.ts`    | discovers `Queued` jobs addressed to this runner by polling `job_count`/`get_job`.                    |
| `src/contract.ts`   | runner-side ABI access (`RunnerEscrow`) behind `EscrowReader`/`EscrowWriter`; reads work with no key. |
| `src/executor.ts`   | Docker sandbox: resource limits, timeout, log capture, cleanup.                                       |
| `src/proof.ts`      | SHA-256 output hashing and the metered `ExecutionProof`.                                              |
| `src/specs.ts`      | reads the job's image/command and verifies the requester's signature.                                 |
| `src/verify.ts`     | re-executes a proved job and compares hash + exit code.                                               |
| `src/verify-cli.ts` | `pulserun-verify` entrypoint: read-only verification, exit codes.                                     |
| `src/config.ts`     | environment configuration and logging.                                                                |

## Design choices

- **Polling, not events.** `PulseEscrow` emits no events yet, so the daemon
  reconciles state from `job_count` and `get_job`. An event-driven indexer is a
  planned pulserun-core change; when it lands, the watcher can be swapped without
  touching the executor or the proof builder.
- **Everything external is injectable.** The RPC server, container runtime,
  spec store and escrow client are constructor arguments, so the suites run in
  milliseconds with no network and no Docker.
- **A local failure never submits a wrong proof.** If Docker is down or a spec is
  missing, the daemon logs and retries on the next poll; it never fabricates a
  proof to settle a job.
- **The spec file is untrusted input.** A runner only executes a job whose
  image and command were signed by the on-chain requester, so write access to a
  shared file is not authority to choose a command.
- **Reads need no key.** `RunnerEscrow` takes an optional signer and simulates
  reads from an ephemeral source account, which is what lets `pulserun-verify`
  check a proof from any machine.
- **Amounts are `bigint`.** Token base units and `i128` values are never routed
  through a JavaScript `number`.
