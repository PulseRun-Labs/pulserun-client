<!--
Thanks for contributing to PulseRun! Keep this description accurate — reviewers
use it to decide what to scrutinize.
-->

## Summary

<!-- What does this PR change, and why? -->

## Related issue

<!-- e.g. Closes #123 -->

## Scope

<!-- Delete what doesn't apply. -->

- [ ] `trivial` — 100 pts
- [ ] `medium` — 150 pts
- [ ] `high` — 200 pts
- [ ] Not applicable

## Packages touched

- [ ] `@pulserun/cli`
- [ ] `@pulserun/daemon`
- [ ] Workspace tooling / CI / docs

## Changes

<!-- Bullet the notable changes. Group by package if it helps. -->

-

## How it was tested

<!--
Describe the tests you added or ran. Name the behaviors they cover, including
the failure/error path where relevant.
-->

-

## Verification

<!--
Run the full gate locally. Check off only what actually passed.
-->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`

## Reviewer focus

<!--
What should a reviewer look at hardest? Contract-call encoding, auth, polling
correctness, sandbox limits, error handling, or the CLI's public output?
-->

-

## Checklist

- [ ] No secret keys or private endpoints in code, logs, or fixtures.
- [ ] Contract calls stay behind the injectable client so tests need no network.
- [ ] New behaviour is covered by a test that fails without this change.
- [ ] Public behaviour (flags, env vars, JSON output, contract calls) is documented.
- [ ] `README.md` / docs updated if the public API changed.
- [ ] No unrelated edits are bundled into this PR.
