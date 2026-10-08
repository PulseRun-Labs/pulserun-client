# Developer guide

## Prerequisites

- **Node.js >= 22.12.0**
- **pnpm 12** (`corepack enable` picks up the pinned version)
- **Docker** — only to exercise the daemon's sandbox executor

## Local setup

```bash
git clone https://github.com/PulseRun-Labs/pulserun-client
cd pulserun-client
pnpm install
pnpm build
pnpm test
```

The full gate, in the order CI runs it:

```bash
pnpm lint        # prettier --check . && eslint .
pnpm typecheck   # tsc --noEmit for every package
pnpm build       # tsc build into packages/*/dist
pnpm test        # vitest for every package
```

## Environment

| Variable                            | Where       | Example / source                                                 |
| ----------------------------------- | ----------- | ---------------------------------------------------------------- |
| `PULSEESCROW_ID`                    | cli, daemon | `PulseEscrow` contract id from pulserun-core's deployment record |
| `PULSERUN_SECRET_KEY`               | cli, daemon | the requester's or runner's `S...` seed                          |
| `PULSERUN_NETWORK`                  | cli, daemon | `testnet` (default) / `futurenet` / `mainnet` / `local`          |
| `STELLAR_RPC_URL`                   | cli, daemon | `https://soroban-testnet.stellar.org`                            |
| `STELLAR_NETWORK_PASSPHRASE`        | cli, daemon | `Test SDF Network ; September 2015`                              |
| `MOCKTOKEN_ID` / `PAYMENT_TOKEN_ID` | cli         | default payment token for `run`                                  |
| `PULSERUN_JOB_SPECS_FILE`           | daemon      | job id → `{ image, command }` map                                |

Contract ids are read from pulserun-core's
[testnet deployment record](https://github.com/PulseRun-Labs/pulserun-core/blob/main/docs/deployments/testnet.md)
— never guessed.

Copy `.env.example` to `.env` for local runs. `.env` is gitignored.

## Using the CLI programmatically

Both commands and the client are exported, so the CLI is embeddable and testable.

```ts
import { PulseRunClient, parseTokenAmount } from '@pulserun/cli/client/soroban';

const client = PulseRunClient.fromSecretKey(process.env.PULSERUN_SECRET_KEY!, {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  contractId: process.env.PULSEESCROW_ID!,
});

const { jobId } = await client.createJob({
  runner: RUNNER_ADDRESS,
  paymentToken: process.env.MOCKTOKEN_ID!,
  maxBudget: parseTokenAmount('1.5', 7),
  ratePerSecond: parseTokenAmount('0.001', 7),
  maxDurationSecs: 900,
});

const job = await client.waitForJob(jobId, { onPoll: (j) => console.log(j.status) });
```

Reads are simulated and need no key:

```ts
const job = await client.getJob(42n);
const proof = await client.getProof(42n); // null until one lands
```

## Running a runner locally

```bash
export PULSEESCROW_ID=C...
export PULSERUN_SECRET_KEY=S...
export PULSERUN_NETWORK=testnet
pulserun-daemon --once   # one poll cycle, then exit
```

The runner loads each job's image and command from `PULSERUN_JOB_SPECS_FILE`
(see [the job-spec gap](../README.md#the-job-spec-gap)). Record an entry with the
CLI:

```bash
pulserun run --runner "$RUNNER" --token "$MOCKTOKEN_ID" \
  --max-budget 1.5 --rate 0.001 --max-duration 900 \
  --image node:22-alpine --cmd "pnpm test" --spec-out ./jobs.json
```

## Testing

The suites never touch the network or Docker. Every external dependency is
injected:

- `SorobanRpcServer` / `ContractRpcServer` — fake RPC responses.
- `ContainerRuntime` — a fake container whose wait/logs/inspect you control.
- `EscrowReader` / `EscrowWriter` — a fake escrow.
- `JobSpecStore` — a fake spec source.

```bash
pnpm --filter @pulserun/cli test
pnpm --filter @pulserun/daemon test
pnpm test:coverage
```

## Building

```bash
pnpm build
node packages/cli/dist/index.js --help
node packages/daemon/dist/index.js --help
```

## Repository layout

See [Architecture](architecture.md) for the module map, and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for conventions and the PR flow.
