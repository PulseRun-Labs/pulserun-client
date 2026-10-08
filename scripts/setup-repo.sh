#!/usr/bin/env bash
#
# Apply the program-ready GitHub settings to PulseRun Client: repository topics
# and branch protection on `main`.
#
# Idempotent: topics are added in place and branch protection is overwritten with
# the same rules on each run.
#
# Requires: gh CLI authenticated with admin scope on the repository.
# Usage:    ./scripts/setup-repo.sh [owner/repo]
set -euo pipefail

REPO="${1:-PulseRun-Labs/pulserun-client}"
BRANCH="main"
# Must match the job `name:` in .github/workflows/ci.yml exactly.
REQUIRED_CHECK="Lint, typecheck, build and test"

echo "==> Setting topics on ${REPO}"
gh repo edit "${REPO}" \
  --add-topic stellar \
  --add-topic soroban \
  --add-topic cli \
  --add-topic daemon \
  --add-topic docker \
  --add-topic typescript \
  --add-topic escrow \
  --add-topic compute

echo "==> Protecting ${BRANCH} on ${REPO}"
gh api --method PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["${REQUIRED_CHECK}"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "==> Done. Topics set and ${BRANCH} protected on ${REPO}."
