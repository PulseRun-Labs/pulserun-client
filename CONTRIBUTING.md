# Contributing to pulserun-client

Thanks for helping build PulseRun! This repository contains the developer CLI
(`@pulserun/cli`) and the runner daemon (`@pulserun/daemon`) for the PulseRun
protocol on Stellar.

## Prerequisites

- **Node.js** >= 22.12.0
- **pnpm** 12.x (`corepack enable` picks up the pinned version)
- **Docker** — only needed to exercise the daemon's sandbox executor

## Getting started

```bash
git clone https://github.com/PulseRun-Labs/pulserun-client.git
cd pulserun-client
pnpm install
```

Copy `.env.example` to `.env` and fill in `PULSERUN_CONTRACT_ID` and
`PULSERUN_SECRET_KEY` if you want to talk to a real network. Never commit a
secret key.

## Repository layout

```text
packages/
  cli/      @pulserun/cli    — `pulserun run` / `pulserun status`
  daemon/   @pulserun/daemon — watches escrow events and runs sandboxes
```

Each package owns its source in `src/` and its tests in `test/`. Tests are
written with [Vitest](https://vitest.dev/) and run in a Node environment.

## Scripts

Run these from the repository root; they fan out to every package with pnpm.

| Command              | What it does                                      |
| -------------------- | ------------------------------------------------- |
| `pnpm build`         | Compiles both packages to `dist/` (`tsc`)         |
| `pnpm typecheck`     | Type-checks all packages without emitting (`tsc`) |
| `pnpm test`          | Runs the Vitest suites for every package          |
| `pnpm test:coverage` | Runs the suites with coverage                     |
| `pnpm lint`          | `prettier --check .` followed by `eslint .`       |
| `pnpm format`        | Rewrites files with Prettier                      |

## Coding standards

- **TypeScript first.** Everything is `strict`, `noUncheckedIndexedAccess` and
  `isolatedModules` are on. Prefer explicit types at module boundaries.
- **Formatting is enforced.** Run `pnpm format` before pushing; CI runs
  `prettier --check .`.
- **Keep the network at the edges.** Anything that talks to Soroban RPC or
  Docker should sit behind a narrow interface (see `SorobanRpcServer`,
  `ContainerRuntime`, `EventSource`) so it can be replaced with a fake in
  tests.
- **No keys in code or logs.** Secret keys come from flags or
  `PULSERUN_SECRET_KEY` and must never be printed.
- **Explain the why.** Comments should describe intent, especially around
  escrow economics, resource limits and timeouts.

## Tests

Add tests next to the behaviour you change:

```bash
pnpm --filter @pulserun/cli test
pnpm --filter @pulserun/daemon test
```

The suites deliberately avoid the network and Docker: RPC servers, Docker
runtimes and the job watcher's event source are all injected fakes.

## Pull requests

1. Branch off `main`.
2. Make your change with tests and docs.
3. Ensure `pnpm lint && pnpm typecheck && pnpm test` pass locally.
4. Open a PR using the template and describe the behaviour change.

## Drips Wave contributors

Issues in `PulseRun-Labs/pulserun-client` are labelled with Wave points
(trivial 100, medium 150, high 200). Use the matching issue template when
filing new work, and reference the issue you are closing in your PR.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](./LICENSE).
