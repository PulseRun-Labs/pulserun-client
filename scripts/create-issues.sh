#!/usr/bin/env bash
#
# Create the PulseRun Client backlog on GitHub in one run: labels first, then
# every planned issue with a Summary / Acceptance Criteria / Tech Stack body.
#
# Idempotent: issues whose exact title already exists (open or closed) are
# skipped, so re-running after adding an issue to this file only creates the new
# ones. Labels are created with --force so colors update in place.
#
# Requires: gh CLI authenticated with push access.
# Usage:    ./scripts/create-issues.sh [owner/repo]
set -euo pipefail

REPO="${1:-PulseRun-Labs/pulserun-client}"
GH=(gh -R "${REPO}")

echo "==> Creating/updating labels on ${REPO}"
create_label() { "${GH[@]}" label create "$1" --color "$2" --description "$3" --force >/dev/null; }
create_label "backlog"       "7D00FF" "Planned backlog task"
create_label "trivial"       "C5DEF5" "Effort: trivial"
create_label "medium"        "BFD4F2" "Effort: medium"
create_label "high"          "D4C5F9" "Effort: high"
create_label "100pts"        "0E8A16" "Size points: 100"
create_label "150pts"        "1D76DB" "Size points: 150"
create_label "200pts"        "B60205" "Size points: 200"
create_label "cli"           "5319E7" "@pulserun/cli work"
create_label "daemon"        "1D76DB" "@pulserun/daemon work"
create_label "testing"       "FBCA04" "Test coverage"
create_label "security"      "D93F0B" "Security-relevant"
create_label "documentation" "0075CA" "Docs and guides"
create_label "ci"            "006B75" "Build and CI"

echo "==> Reading existing issues"
EXISTING="$("${GH[@]}" issue list --state all --limit 1000 --json title --jq '.[].title')"

create_issue() {
  local title="$1" labels="$2" body="$3"
  if printf '%s\n' "${EXISTING}" | grep -Fxq "${title}"; then
    echo "    skip (exists): ${title}"
    return 0
  fi
  "${GH[@]}" issue create --title "${title}" --label "${labels}" --body "${body}" >/dev/null
  echo "    created: ${title}"
}

echo "==> Creating issues"

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

create_issue \
  "feat(cli): add a signer abstraction so keys need not be raw S... env vars" \
  "backlog,high,200pts,cli,security" \
  "$(cat <<'EOF'
## Summary

Every write command today requires a raw secret key via `--key` or
`PULSERUN_SECRET_KEY`. Add a signer interface so callers can plug in a
hardware wallet, an OS keychain, or a remote signer without the CLI ever holding
a seed.

## Acceptance Criteria

- [ ] `Signer` interface with `publicKey()` and `sign(tx)`; `KeypairSigner` wraps the current path
- [ ] `PulseRunClient` accepts a `Signer` instead of a `Keypair`
- [ ] `--signer <command>` spawns an external signer over stdio (documented protocol)
- [ ] Secret keys are still never logged or persisted
- [ ] Tests: a fake signer drives `create_job` end to end

## Tech Stack

TypeScript, `@stellar/stellar-sdk`. Touches `packages/cli/src/client/soroban.ts`, `packages/cli/src/config.ts`, `packages/cli/src/commands/*`.
EOF
)"

create_issue \
  "feat(cli): add \`pulserun jobs\` to list jobs by requester or runner" \
  "backlog,medium,150pts,cli" \
  "$(cat <<'EOF'
## Summary

There is no way to see your own job history from the CLI; you must remember ids.
Add a `jobs` command that lists jobs the signing address requested or ran.

## Acceptance Criteria

- [ ] `pulserun jobs [--role requester|runner] [--limit N]`
- [ ] Reads `job_count` then `get_job`, filtering by the signer's address
- [ ] Renders a table; `--json` emits the same rows
- [ ] Bounded scanning with a clear message when the range is large
- [ ] Tests: filtering, pagination bounds, empty result

## Tech Stack

TypeScript, `@stellar/stellar-sdk`. Adds `packages/cli/src/commands/jobs.ts`.
EOF
)"

create_issue \
  "feat(cli): dry-run create_job and print the simulated result before signing" \
  "backlog,medium,150pts,cli" \
  "$(cat <<'EOF'
## Summary

`run` signs and submits in one step. Add `--dry-run` that simulates `create_job`
and prints the would-be result (and any contract error) without sending a
transaction, so amounts and addresses can be checked safely.

## Acceptance Criteria

- [ ] `pulserun run --dry-run` builds, simulates, prints the outcome, and exits without signing
- [ ] Contract errors are decoded to their ABI name
- [ ] `--json` emits a `dryRun: true` payload
- [ ] Tests: happy path and a rejected simulation

## Tech Stack

TypeScript, `@stellar/stellar-sdk`. Touches `packages/cli/src/commands/run.ts`.
EOF
)"

create_issue \
  "feat(cli): add \`pulserun config\` to show resolved network, contract and token" \
  "backlog,trivial,100pts,cli" \
  "$(cat <<'EOF'
## Summary

Debugging env resolution is guesswork. Add a `config` command that prints the
network, RPC URL, passphrase, contract id and resolved payment token, without
printing any secret.

## Acceptance Criteria

- [ ] `pulserun config` prints the resolved values, masking the secret key
- [ ] `--json` emits the same object
- [ ] Errors clearly when a required value is missing
- [ ] Tests for flag/env precedence matching `resolveConnection`

## Tech Stack

TypeScript. Adds `packages/cli/src/commands/config.ts`.
EOF
)"

# ---------------------------------------------------------------------------
# Daemon
# ---------------------------------------------------------------------------

create_issue \
  "feat(daemon): fetch job specs from a remote store to close the job-spec gap" \
  "backlog,high,200pts,daemon" \
  "$(cat <<'EOF'
## Summary

`PulseEscrow` stores no command line, so the daemon reads image/command from a
local file. Provide a `JobSpecStore` implementation that fetches specs from a
remote source (HTTP/git) so a runner need not share a filesystem with the
requester. Ideally this is superseded by an on-chain metadata hash in
pulserun-core.

## Acceptance Criteria

- [ ] New `RemoteJobSpecStore` implementing the existing `JobSpecStore` interface
- [ ] Configurable base URL via env; timeouts and non-2xx handled with a typed error
- [ ] Missing spec still means "skip, do not fabricate a proof"
- [ ] Tests: happy path, 404, timeout, malformed payload

## Tech Stack

TypeScript, `node:fetch`. Touches `packages/daemon/src/specs.ts`, `packages/daemon/src/config.ts`.
EOF
)"

create_issue \
  "feat(daemon): persist the discovery high-water mark across restarts" \
  "backlog,medium,150pts,daemon" \
  "$(cat <<'EOF'
## Summary

On restart the daemon re-scans job ids from 1, which is wasteful on a busy
contract. Persist the highest scanned id (and any pending jobs) so a restart
resumes where it left off.

## Acceptance Criteria

- [ ] Water-mark written to a configurable path atomically after each poll
- [ ] A corrupt or missing file falls back to a full scan
- [ ] Pending jobs survive a restart
- [ ] Tests: resume, corrupt file, missing file

## Tech Stack

TypeScript, `node:fs`. Touches `packages/daemon/src/watcher.ts`.
EOF
)"

create_issue \
  "fix(daemon): back off on repeated RPC failures instead of hot-looping" \
  "backlog,medium,150pts,daemon" \
  "$(cat <<'EOF'
## Summary

A failing RPC endpoint is retried every `PULSERUN_POLL_INTERVAL_MS`. Add
exponential backoff with jitter so an outage does not hammer the endpoint or burn
CPU.

## Acceptance Criteria

- [ ] Consecutive failures increase the delay up to a configurable cap
- [ ] A success resets the delay
- [ ] Backoff does not swallow the error — it is still logged
- [ ] Tests with a fake clock cover growth and reset

## Tech Stack

TypeScript. Touches `packages/daemon/src/index.ts`.
EOF
)"

create_issue \
  "feat(daemon): emit structured JSON logs with job context" \
  "backlog,trivial,100pts,daemon" \
  "$(cat <<'EOF'
## Summary

The logger writes plain lines. Add an opt-in JSON mode so logs can be shipped and
queried without parsing prose.

## Acceptance Criteria

- [ ] `PULSERUN_LOG_FORMAT=json` emits one JSON object per line with `level`, `time`, `msg`
- [ ] Job-scoped records include `jobId`
- [ ] Default text format is unchanged
- [ ] Tests assert the JSON shape

## Tech Stack

TypeScript. Touches `packages/daemon/src/config.ts`.
EOF
)"

# ---------------------------------------------------------------------------
# Testing
# ---------------------------------------------------------------------------

create_issue \
  "test(cli): cover the error-code mapping for every ABI variant" \
  "backlog,medium,150pts,testing" \
  "$(cat <<'EOF'
## Summary

`ERROR_CODES` maps 1..14 to names. A regression that drops or renumbers a code
would be silent. Lock the table down with a test that asserts every code.

## Acceptance Criteria

- [ ] Table-driven test asserts all 14 codes and their names
- [ ] A test asserts `extractErrorCode` parses real RPC error strings
- [ ] `pnpm test` clean

## Tech Stack

Vitest. Touches `packages/cli/test/soroban.test.ts`.
EOF
)"

create_issue \
  "test(daemon): property test that a local failure never submits a proof" \
  "backlog,high,200pts,testing" \
  "$(cat <<'EOF'
## Summary

The safety property is that a local fault (Docker down, missing spec, RPC error
during execution) never results in a proof being submitted. Prove it over many
random failure points rather than a couple of hand-written cases.

## Acceptance Criteria

- [ ] Fuzz the executor/spec/escrow fakes to fail at random steps
- [ ] Assert `submitProof` is never called when execution did not complete
- [ ] Assert a successful run always submits exactly one proof
- [ ] Deterministic seeds logged on failure

## Tech Stack

Vitest. Touches `packages/daemon/test/index.test.ts`.
EOF
)"

# ---------------------------------------------------------------------------
# Docs and CI
# ---------------------------------------------------------------------------

create_issue \
  "docs: write a threat model for the CLI and daemon" \
  "backlog,medium,150pts,documentation,security" \
  "$(cat <<'EOF'
## Summary

`SECURITY.md` names the scope but there is no standalone threat model. Write one
covering trust boundaries and the exact mechanism of each threat.

## Acceptance Criteria

- [ ] `docs/threat-model.md` covering key handling, sandbox escape, RPC
      man-in-the-middle, and proof integrity
- [ ] Each threat names the module and the failure mode, not a vague claim
- [ ] Linked from `SECURITY.md` and `docs/SUMMARY.md`

## Tech Stack

Markdown. Adds `docs/threat-model.md`.
EOF
)"

create_issue \
  "ci: publish coverage and fail under a threshold" \
  "backlog,trivial,100pts,ci" \
  "$(cat <<'EOF'
## Summary

CI runs the tests but never measures coverage or uploads it, so regressions in
test depth are invisible.

## Acceptance Criteria

- [ ] `pnpm test:coverage` runs both packages and uploads a report
- [ ] CI fails below a documented line-coverage threshold
- [ ] Threshold recorded in `docs/developer-guide.md`

## Tech Stack

GitHub Actions, Vitest. Touches `.github/workflows/ci.yml`.
EOF
)"

create_issue \
  "ci: add a dependency and license audit job" \
  "backlog,trivial,100pts,ci" \
  "$(cat <<'EOF'
## Summary

CI does not audit dependencies for advisories or disallowed licenses. Add an
audit job so a supply-chain problem fails the build.

## Acceptance Criteria

- [ ] A job runs `pnpm audit --audit-level high` (or equivalent) and fails on findings
- [ ] License check added and configured
- [ ] Command documented in `CONTRIBUTING.md`

## Tech Stack

GitHub Actions, pnpm. Touches `.github/workflows/ci.yml`.
EOF
)"

echo "==> Done. View the backlog: gh issue list -R ${REPO} --label backlog"
