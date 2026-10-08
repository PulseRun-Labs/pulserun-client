---
name: 'Task · Trivial (100 pts)'
about: Small, isolated task — docs, a tiny fix, or a one-file change.
title: '[trivial] '
labels: ['backlog', 'trivial', '100pts']
assignees: ''
---

<!--
Trivial · 100 points
Scope: docs, tiny fixes, an isolated helper or view, one-file changes.
Keep the diff small; if it grows, the task is probably medium.
-->

## Summary

<!-- One or two sentences describing the task. -->

## Motivation

<!-- Why does this matter for the escrow/settlement flow or the CLI/daemon? -->

## Acceptance criteria

<!--
Checklist of concrete, verifiable outcomes. Include the exact artifacts to
change and the test that must pass. Example:
- [ ] `getVesting` view added to `packages/cli/src/client/soroban.ts`
- [ ] Covered by a test in `packages/cli/test/soroban.test.ts`
- [ ] `pnpm typecheck && pnpm test` clean
-->

- [ ]
- [ ]
- [ ]

## Scope guardrails

- Touches at most one package (`@pulserun/cli` or `@pulserun/daemon`).
- No changes to the contract ABI or environment variable names.
- No new dependencies.

## Points

**100 pts** · Effort: trivial

## Useful context

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
- Contract client: [`packages/cli/src/client/soroban.ts`](../../packages/cli/src/client/soroban.ts)
- Runner loop: [`packages/daemon/src/index.ts`](../../packages/daemon/src/index.ts)
