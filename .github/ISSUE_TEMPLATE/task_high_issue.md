---
name: 'Task · High (200 pts)'
about: Cross-cutting design task — new flows spanning both packages, or on-chain interaction changes.
title: '[high] '
labels: ['backlog', 'high', '200pts']
assignees: ''
---

<!--
High · 200 points
Scope: cross-cutting design work — a new end-to-end flow, settlement-adjacent
logic, security hardening, or an on-chain interaction change. Expect a design
note in the PR.
-->

## Summary

<!-- One paragraph describing the objective and the end state. -->

## Problem statement

<!-- What is wrong or missing today? Quantify where possible (correctness, liveness, cost). -->

## Proposed approach

<!-- Outline the design. Call out the invariants it must preserve and the state transitions it introduces. -->

## Acceptance criteria

<!--
Verifiable outcomes, including invariants and tests. Example:
- [ ] Indexer reconciles job state from `get_job` without missing a transition
- [ ] A local execution failure never submits a wrong proof (asserted in tests)
- [ ] Full CI gate green
-->

- [ ]
- [ ]
- [ ]

## Invariants & risk

<!-- What must always hold? What could break? What is the recovery path if it goes wrong on-chain? -->

- Invariant:
- Risk:
- Recovery:

## Design note required

The PR must include a short note covering: the flow end to end, the contract
calls and their auth, failure modes (RPC outage, Docker failure, timeout), and
how existing jobs keep working.

## Scope guardrails

- May touch multiple packages, but must not change existing contract error codes.
- Any ABI assumption change must state which pulserun-core version it targets.

## Points

**200 pts** · Effort: high

## Useful context

- [`docs/protocol-mechanics.md`](../../docs/protocol-mechanics.md)
- [`docs/architecture.md`](../../docs/architecture.md)
- pulserun-core: <https://github.com/PulseRun-Labs/pulserun-core>
