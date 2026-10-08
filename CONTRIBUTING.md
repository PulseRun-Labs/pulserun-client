# Contributing to PulseRun Client

Thanks for helping build the application layer for pay-per-run compute on
Stellar. This guide gets you from zero to a merged pull request.

This repository is the **client** half of PulseRun. The on-chain escrow and
settlement contracts live in
[pulserun-core](https://github.com/PulseRun-Labs/pulserun-core); the client is
written against that contract's published ABI.

## Getting set up

You need **Node.js >= 22.12.0** and **pnpm 12** (`corepack enable` picks up the
pinned version). Docker is only needed to exercise the daemon's sandbox.

```bash
git clone https://github.com/PulseRun-Labs/pulserun-client
cd pulserun-client

pnpm install
pnpm build
pnpm test          # should be green before you start
```

Copy `.env.example` to `.env` if you want to talk to a real network, and fill in
`PULSEESCROW_ID` and `PULSERUN_SECRET_KEY`. Never commit a secret key.

## Repository layout

```text
packages/
  cli/      @pulserun/cli    — `pulserun run` / `status` / `claim` / `dispute` / `cancel`
  daemon/   @pulserun/daemon — watches for jobs, runs sandboxes, submits proofs
```

Each package owns its source in `src/` and its tests in `test/`. Tests are
written with [Vitest](https://vitest.dev/) and run in a Node environment.

## The local gate

CI runs exactly these commands. Run them before opening a PR:

```bash
pnpm lint          # prettier --check . && eslint .
pnpm typecheck     # tsc --noEmit for every package
pnpm build         # tsc build into packages/*/dist
pnpm test          # vitest for every package
```

`pnpm format` rewrites files; the `lint` gate only verifies. Fix warnings rather
than silencing them — if a suppression is genuinely warranted, explain why in the
PR description.

## Coding standards

- **TypeScript first.** Everything is `strict` with `noUncheckedIndexedAccess`.
  No `any` — use `unknown` and narrow.
- **Amounts are `bigint`, never `number`.** Token amounts are integer base units;
  parse and format them with the helpers in `soroban.ts` / `contract.ts`.
- **Keep the network and Docker at the edges.** Soroban RPC and the container
  runtime sit behind narrow interfaces (`SorobanRpcServer`, `ContainerRuntime`,
  `EscrowReader`/`EscrowWriter`) so they can be replaced with fakes in tests.
- **Match the contract ABI by number.** Contract error codes are part of the
  public ABI — branch on the numeric value, never renumber.
- **No keys in code or logs.** Secret keys come from flags or
  `PULSERUN_SECRET_KEY` and must never be printed or persisted.
- **Explain the why.** Comments should describe intent, especially around
  settlement, resource limits and timeouts.

## Test conventions

The suites never touch the network or Docker: Soroban RPC servers, container
runtimes, the job spec store and the escrow client are all injected fakes.

```bash
pnpm --filter @pulserun/cli test
pnpm --filter @pulserun/daemon test
```

- Keep each test to one behavior, named as a sentence about that behavior.
- Assert contract errors by their numeric code.
- New behavior needs a test that fails without the change.

## Finding and scoping work

Open work is tracked in the
[issue backlog](https://github.com/PulseRun-Labs/pulserun-client/issues). Issues
carry a size label so you can pick something that matches the time you have:

| Label     | Scope                                                                |
| --------- | -------------------------------------------------------------------- |
| `trivial` | Docs, tiny fixes, isolated helpers, one-file changes.                |
| `medium`  | A new command or daemon capability, a multi-case test suite.         |
| `high`    | Cross-cutting design work spanning packages or on-chain interaction. |

**How to pick up work**

1. Find an open issue and comment to be assigned it.
2. Open a **draft PR** early and link the issue (`Closes #123`).
3. Push until the full gate is green; keep the diff focused on the issue.
4. Request review once CI passes.

**Definition of done:** CI green, the behavior is covered by a test that fails
without your change, and the PR has no unrelated edits.

## Pull requests

Use the [pull request template](.github/pull_request_template.md). A good PR:

- Links its issue and states the scope it targets.
- Explains _why_, not just _what_.
- Calls out anything a reviewer should scrutinize (contract-call encoding,
  authorization, polling, sandbox limits, timeouts).
- Updates `README.md` when the public behavior changes.

## Reporting security issues

Do **not** open a public issue for vulnerabilities. Email
`security@pulserun.com` with a description and reproduction; we'll acknowledge
within 72 hours. See [`SECURITY.md`](SECURITY.md).

## License

By contributing you agree that your work is licensed under the
[MIT License](LICENSE).
