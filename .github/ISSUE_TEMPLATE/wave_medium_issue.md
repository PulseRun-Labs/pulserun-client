---
name: 'Wave: Medium (150 pts)'
about: A focused feature or refactor worth 150 Drips Wave points
title: '[Medium] '
labels: ['wave', 'wave:medium', 'points:150']
assignees: ''
---

## Summary

<!-- What are we building, and for which package (@pulserun/cli or @pulserun/daemon)? -->

## Motivation

<!-- The problem this solves. Link related issues or discussions. -->

## Proposed approach

<!--
Sketch the implementation. Call out the interfaces you plan to introduce or
reuse, e.g. SorobanRpcServer, ContainerRuntime, EventSource, ProofSubmitter.
Keep the network and Docker behind injectable interfaces so tests stay fast.
-->

## Scope

- [ ] <!-- Implementation step -->
- [ ] Tests for the happy path and at least one failure path
- [ ] README / `.env.example` updated for any new flag or variable
- [ ] `--json` output updated if the change affects command output

## Acceptance criteria

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] New behaviour is testable without a live network or Docker daemon
- [ ] Errors are surfaced with actionable messages (no raw stack traces)
- [ ] No secret keys are logged or persisted

## Risks and edge cases

<!-- Timeouts, partial failures, RPC outages, malformed contract responses, ... -->

## Out of scope

<!-- Keep the PR reviewable. -->

## Drips Wave

**Points:** `150` (medium)
