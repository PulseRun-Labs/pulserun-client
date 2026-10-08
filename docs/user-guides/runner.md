# For runners

A runner executes jobs and gets paid for the seconds it works. You need Docker, a
Stellar key, and the PulseEscrow contract id.

## What the daemon does

For every job addressed to your key, `pulserun-daemon`:

1. **Discovers** it — the contract emits no events, so the daemon polls
   `job_count` and `get_job`, keeping only `Queued` jobs whose `runner` is you.
2. **Executes** it in an isolated Docker sandbox — hard CPU, memory and PID
   limits, no network by default, and a wall-clock timeout bounded by the job's
   on-chain expiry.
3. **Proves** it — hashes the combined output with SHA-256 and calls
   `submit_proof` with the measured `duration_secs`.
4. **Claims** the payout once the dispute window has elapsed (unless disabled).

Your payout is `min(rate_per_second * duration_secs, max_budget)` — always at
least what you proved, never more than the escrow holds.

## Run it

```bash
export PULSEESCROW_ID=C...
export PULSERUN_SECRET_KEY=S...        # your runner key
export PULSERUN_NETWORK=testnet
export PULSERUN_JOB_SPECS_FILE=./jobs.json
export PULSERUN_CPU_LIMIT=2
export PULSERUN_MEMORY_LIMIT_MB=2048

pulserun-daemon            # runs until SIGINT/SIGTERM
pulserun-daemon --once     # one poll cycle, then exit (cron-friendly)
```

## The job spec

The contract pins the money and the parties, not the command line. The daemon
reads each job's image and command from a JSON file keyed by job id:

```json
{
  "42": { "image": "node:22-alpine", "command": "pnpm test" }
}
```

A requester on the same host can write an entry automatically:

```bash
pulserun run --runner "$YOUR_KEY" --token "$MOCKTOKEN_ID" \
  --max-budget 1.5 --rate 0.001 --max-duration 900 \
  --image node:22-alpine --cmd "pnpm test" --spec-out ./jobs.json
```

If a job has no spec, the daemon logs it and leaves the job alone — it will retry
on the next poll, or expire and refund the requester. It never invents a command.

## Safety

- Jobs run offline by default (`NetworkMode: none`) unless
  `PULSERUN_ALLOW_NETWORK=true`.
- Every sandbox gets `MemorySwap == Memory`, a `PidsLimit`, and CPU caps.
- Timed-out sandboxes are killed and reported with exit code `124`.
- If Docker is down, the daemon does **not** submit a proof — the job is left for
  a retry or to expire, so a broken runner cannot slash an honest job.

## Getting paid

Settlement is automatic by default (`PULSERUN_AUTO_CLAIM=true`): once a proven
job's dispute window elapses, the daemon calls `claim_payout`. To do it manually,
or to check on a job, use the CLI:

```bash
pulserun status 42
pulserun claim 42
```
