# Contributing

The full guide lives in [`CONTRIBUTING.md`](../CONTRIBUTING.md) at the repository
root. In short:

1. Branch off `main`.
2. Make your change with tests and docs.
3. Ensure `pnpm lint && pnpm typecheck && pnpm build && pnpm test` pass locally.
4. Open a PR using the template and describe the behaviour change.

## Where work lives

The client is one half of PulseRun; the other half is
[pulserun-core](https://github.com/PulseRun-Labs/pulserun-core). Changes that
alter the contract ABI belong in core and must be reflected here (types, error
codes, call encoding) in the same release cycle.

## Conventions

- Everything is TypeScript `strict`; no `any`.
- Amounts are `bigint`, never `number`.
- Keep Soroban RPC and Docker behind injectable interfaces so tests stay fast.
- Never log or persist a secret key.

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](../SECURITY.md).
