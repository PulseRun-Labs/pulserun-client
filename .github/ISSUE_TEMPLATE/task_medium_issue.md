---
name: 'Task · Medium (150 pts)'
about: A focused feature, refactor, or new command covering a single flow.
title: '[medium] '
labels: ['backlog', 'medium', '150pts']
assignees: ''
---

<!--
Medium · 150 points
Scope: a new command, a new daemon capability, a refactor across a package, or a
multi-case test suite. Expect a focused PR with tests for the happy path and at
least one failure path.
-->

## Summary

<!-- What are we building, and for which package (@pulserun/cli or @pulserun/daemon)? -->

## Motivation

<!-- The problem this solves. Link related issues or discussions. -->

## Proposed approach

<!--
Sketch the implementation. Call out the interfaces you plan to introduce or
reuse (e.g. `PulseRunClient`, `RunnerEscrow`, `ContainerRuntime`, `JobSpecStore`)
and keep the network and Docker behind injectable seams so tests stay fast.
-->

## Acceptance criteria

<!--
Concrete, verifiable outcomes. Example:
- [ ] `pulserun claim <job_id>` calls `claim_payout` and prints the earnings
- [ ] Tested against the fake RPC server (happy path + a rejected transaction)
- [ ] Documented in `docs/contract-reference.md` and `.env.example`
- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` pass
-->

- [ ]
- [ ]
- [ ]

## Risks and edge cases

<!-- RPC outages, partial failures, malformed contract responses, timeouts, ... -->

## Scope guardrails

- No changes to the contract ABI or the on-chain error codes.
- New behaviour must be testable without a live network or Docker daemon.

## Points

**150 pts** · Effort: medium

## Useful context

- [`docs/contract-reference.md`](../../docs/contract-reference.md)
- [`docs/developer-guide.md`](../../docs/developer-guide.md)
