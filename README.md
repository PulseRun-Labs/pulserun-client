# pulserun-client

Developer CLI and runner daemon for the **PulseRun** protocol on Stellar.

PulseRun lets anyone pay for verifiable compute on untrusted machines. A client
locks a budget in a Soroban escrow contract, a runner executes the job in an
isolated Docker sandbox, and the runner submits a SHA-256 proof of the output
back on-chain. The escrow settles only against that proof.

This repository contains the two TypeScript packages that speak to that
contract:

| Package            | Binary            | Role                                                      |
| ------------------ | ----------------- | --------------------------------------------------------- |
| `@pulserun/cli`    | `pulserun`        | Submits jobs, polls for proofs, prints on-chain status    |
| `@pulserun/daemon` | `pulserun-daemon` | Watches for jobs, executes them in Docker, submits proofs |

## Architecture

```text
        ┌────────────────┐       1. create_job (locks escrow)        ┌───────────────────┐
        │  pulserun CLI  │ ────────────────────────────────────────▶ │  Soroban escrow   │
        │ (client side)  │ ◀──────────────────────────────────────── │    contract       │
        └────────────────┘       2. poll get_job until terminal     └───────────────────┘
                 ▲                                                        ▲       │
                 │ 6. status / proof hash                                 │       │ 3. job_created
                 │                                                        │       │    event
                 │                             4. submit_proof (settles)  │       ▼
                 │                                             ┌──────────────────────────┐
                 └─────────────────────────────────────────────│    pulserun-daemon      │
                                                               │  watcher → executor →   │
                                                               │  proof                  │
                                                               └──────────────────────────┘
                                                                            │
                                                              5. docker run (CPU/RAM caps)
                                                                            ▼
                                                                   ┌────────────────┐
                                                                   │  sandbox image │
                                                                   └────────────────┘
```

**1 — The CLI triggers a job.** `pulserun run --image … --cmd … --max-budget …`
builds a `create_job` invocation with the Stellar SDK, signs it with the
client's secret key and submits it to Soroban RPC.

**2 — Soroban locks escrow.** The contract stores the job, the client and the
runner it is addressed to, locks `max_budget` stroops of XLM, and records a
deadline. Nothing is paid out yet.

**3 — The daemon sees the job.** `pulserun-daemon` polls Soroban RPC for
`job_created` events, decoding each one and keeping only jobs addressed to its
runner public key. Events are paged with a cursor so nothing is missed or
processed twice.

**4 — The daemon executes in a sandbox.** It pulls the requested image and runs
the command with hard CPU, memory and PID limits, with no network by default
and a wall-clock timeout. Logs and the exit code are captured.

**5 — The daemon proves the result.** It hashes the combined output with
SHA-256 and calls `submit_proof(runner, job_id, output_hash, exit_code,
success)`. Anyone can re-run the same image and compare hashes.

**6 — The escrow settles.** The contract releases the budget to the runner when
the proof is valid, or refunds the client when the deadline passes.

## Repository layout

```text
.
├── packages/
│   ├── cli/
│   │   ├── src/
│   │   │   ├── index.ts             # commander entrypoint
│   │   │   ├── config.ts            # flags + PULSERUN_* resolution
│   │   │   ├── ui.ts                # colour, tables, formatting
│   │   │   ├── commands/
│   │   │   │   ├── run.ts           # create_job + poll
│   │   │   │   └── status.ts        # get_job + render
│   │   │   └── client/soroban.ts    # typed Soroban client
│   │   └── test/
│   └── daemon/
│       ├── src/
│       │   ├── index.ts             # watcher → executor → proof wiring
│       │   ├── watcher.ts           # Soroban event polling
│       │   ├── executor.ts          # Docker sandboxing + limits
│       │   ├── proof.ts             # SHA-256 hashing + submit_proof
│       │   └── config.ts            # env config + logging
│       └── test/
├── .github/workflows/ci.yml
└── pnpm-workspace.yaml
```

## Getting started

Requires **Node.js >= 22.12.0**, **pnpm 12** and, for the daemon, **Docker**.

```bash
pnpm install
pnpm build
```

Configuration comes from flags (CLI) or environment variables (daemon). See
[`.env.example`](./.env.example) for the full list.

## Using the CLI

Submit a job and watch it until a runner proves the result:

```bash
pulserun run \
  --image node:22-alpine \
  --cmd "pnpm test" \
  --max-budget 1.5 \
  --key "$PULSERUN_SECRET_KEY" \
  --contract "$PULSERUN_CONTRACT_ID" \
  --network testnet
```

`run` exits `0` when the job completes and `1` when it fails or expires, so it
drops straight into a CI pipeline. Add `--no-wait` to return as soon as the
escrow is locked, or `--json` for machine-readable output.

Inspect a job at any time — no signing key required, the read is a simulation:

```bash
pulserun status 42 --contract "$PULSERUN_CONTRACT_ID"
```

```text
Job #42
  Status        Completed
  Client        GABCDE…WXYZ12
  Runner        GHIJKL…3456NO
  Image         node:22-alpine
  Command       pnpm test
  Budget        1.5 XLM
  Created       2026-01-04T09:12:00.000Z
  Deadline      2026-01-04T10:12:00.000Z (52m 30s left)
  Output hash   0x9f2c…7ab4
  Exit code     0
```

## Running a daemon

```bash
export PULSERUN_CONTRACT_ID=C...
export PULSERUN_SECRET_KEY=S...        # the runner's key
export PULSERUN_NETWORK=testnet
export PULSERUN_CPU_LIMIT=2
export PULSERUN_MEMORY_LIMIT_MB=2048

pulserun-daemon            # runs until SIGINT/SIGTERM
pulserun-daemon --once     # one poll cycle, then exit (cron-friendly)
```

### Daemon configuration

| Variable                       | Default                       | Purpose                                 |
| ------------------------------ | ----------------------------- | --------------------------------------- |
| `PULSERUN_CONTRACT_ID`         | —                             | Escrow contract ID (required)           |
| `PULSERUN_SECRET_KEY`          | —                             | Runner signing key (required)           |
| `PULSERUN_NETWORK`             | `testnet`                     | `testnet`/`futurenet`/`mainnet`/`local` |
| `PULSERUN_RPC_URL`             | network preset                | Soroban RPC endpoint override           |
| `PULSERUN_POLL_INTERVAL_MS`    | `5000`                        | Delay between event polls               |
| `PULSERUN_START_LEDGER_OFFSET` | `100`                         | Ledgers behind the head to start from   |
| `PULSERUN_EVENT_PAGE_LIMIT`    | `100`                         | Events per poll (max 200)               |
| `PULSERUN_DOCKER_HOST`         | `unix:///var/run/docker.sock` | Docker endpoint                         |
| `PULSERUN_CPU_LIMIT`           | `1`                           | Sandbox CPU limit, in cores             |
| `PULSERUN_MEMORY_LIMIT_MB`     | `1024`                        | Sandbox memory limit, in MiB            |
| `PULSERUN_PIDS_LIMIT`          | `256`                         | Max processes inside the sandbox        |
| `PULSERUN_ALLOW_NETWORK`       | `false`                       | Give sandboxes network access           |
| `PULSERUN_JOB_TIMEOUT_SECONDS` | `900`                         | Hard wall-clock limit per job           |
| `PULSERUN_MAX_CONCURRENCY`     | `1`                           | Jobs executed in parallel               |
| `PULSERUN_LOG_LEVEL`           | `info`                        | `debug`/`info`/`warn`/`error`           |

Every sandbox is created with `MemorySwap` pinned to `Memory` (so the limit is a
real ceiling rather than a hint), `PidsLimit` set, and `NetworkMode: none`
unless `PULSERUN_ALLOW_NETWORK` is enabled.

## Escrow contract interface

Both packages are written against this interface:

```rust
create_job(from: Address, runner: Address, image: String, cmd: String,
           max_budget: i128, deadline: u64) -> u64;

get_job(job_id: u64) -> Job;

submit_proof(runner: Address, job_id: u64, output_hash: BytesN<32>,
             exit_code: i32, success: bool);

// Emitted when a job is created. The runner address is the second topic so
// runners can filter server-side.
#[contractevent(topics = ["job_created", runner])]
JobCreated {
    job_id: u64,
    client: Address,
    image: String,
    cmd: String,
    max_budget: i128,
    deadline: u64,
}
```

`Job` carries `job_id`, `client`, `runner`, `image`, `cmd`, `max_budget`,
`deadline`, `created_at`, `status` (`0..5` — Pending, Running, Completed,
Failed, Expired, Cancelled), `output_hash` and `exit_code`.

## Proof model

A proof is the SHA-256 digest of the sandbox's combined stdout/stderr:

```text
output_hash = SHA256(stdout + stderr)
success     = exit_code == 0 && !timed_out
```

Because the digest covers the raw logs, a verifier can re-run the same image and
command and compare hashes without trusting the runner. Timed-out sandboxes are
killed after `PULSERUN_JOB_TIMEOUT_SECONDS` (or earlier, if the on-chain deadline
is closer) and reported with the conventional exit code `124`.

## Development

```bash
pnpm lint        # prettier --check . && eslint .
pnpm typecheck   # tsc --noEmit for every package
pnpm test        # vitest for every package
pnpm build       # tsc build into packages/*/dist
```

The test suites never touch the network or Docker: Soroban RPC servers, Docker
runtimes, the watcher's event source and the proof submitter are all injected,
so the escrow maths, hashing, resource-limit wiring and timeout handling are
covered by fast unit tests.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions and review flow.

## Security notes

- Secret keys are read from `--key` / `PULSERUN_SECRET_KEY` and are never
  written to disk or logged.
- Jobs run offline by default and with CPU, memory and PID ceilings.
- The daemon adds a `pulserun.managed=true` label to every container it creates
  and always removes them, even when log capture fails.
- A local execution failure (for example Docker being down) never submits a
  failing proof — the job is left for a retry or to expire, so a broken runner
  cannot slash an honest job.

## License

[MIT](./LICENSE) © PulseRun Labs
