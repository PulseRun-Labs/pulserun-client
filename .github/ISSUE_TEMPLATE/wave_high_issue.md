---
name: 'Wave: High (200 pts)'
about: A substantial feature spanning packages or touching on-chain behaviour, worth 200 Drips Wave points
title: '[High] '
labels: ['wave', 'wave:high', 'points:200']
assignees: ''
---

## Summary

<!-- What is being delivered, end to end? Which packages are involved? -->

## Motivation

<!--
Why this is worth doing now, and what breaks or stays impossible without it.
Be explicit about any escrow, settlement or proof-integrity implications.
-->

## Design

<!--
Describe the design before writing code. Cover:

- The interfaces you will add or change (CLI, daemon, and any shared shape).
- The contract ABI or event changes this depends on, if any.
- Failure modes: RPC outages, Docker failures, timeouts, partial writes.
- How existing jobs and configurations keep working.
-->

```text
// Sketch the key types / flow here.
```

## Scope

- [ ] Implementation across all affected packages
- [ ] Unit tests for each new module (network and Docker faked)
- [ ] An integration-style test driving the wired flow with fakes
- [ ] README architecture section updated if the flow changes
- [ ] `.env.example` and the config table updated for new variables

## Acceptance criteria

- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` pass
- [ ] The full CI workflow is green on the PR
- [ ] New behaviour is documented where operators will look for it
- [ ] Failure paths degrade safely: a local error never submits a wrong proof
- [ ] Resource limits and secret handling remain unchanged unless this issue
      says otherwise

## Risks

<!-- What could go wrong, and how will we detect it? -->

## Out of scope

<!-- Follow-up issues to file instead of expanding this one. -->

## Drips Wave

**Points:** `200` (high)
