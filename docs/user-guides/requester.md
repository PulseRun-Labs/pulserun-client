# For requesters

A requester pays for a job and gets proof that it ran. You need a Stellar key,
some of a payment token, and the PulseEscrow and payment-token contract ids.

## What you control

- **`max_budget`** — the most you can ever be billed. It is locked up front.
- **`rate_per_second`** — what each executed second costs.
- **`max_duration_secs`** — the most seconds the runner can bill, and the point
  after which an unclaimed job can be refunded.
- **`runner`** — exactly which address may execute the job.

Your spend is `min(rate_per_second * duration, max_budget)`. You can never be
billed past `max_budget`.

## Open a job

```bash
export PULSEESCROW_ID=C...
export PULSERUN_SECRET_KEY=S...       # your key
export MOCKTOKEN_ID=C...              # the token you pay in

pulserun run \
  --runner G_RUNNER_ADDRESS \
  --max-budget 1.5 \
  --rate 0.001 \
  --max-duration 900 \
  --network testnet
```

`run` prints the escrow confirmation and then polls until the job reaches a
terminal state:

```text
Opening escrow on testnet (CCEB…GTYB)
  Runner        GHIJKL…3456NO
  Payment token CCCNLW…HHVF6
  Max budget    1.5 (base units)
  Rate/second   0.001
  Max duration  15m 00s
Job #42 escrowed (tx …, ledger …).
Watching job #42 (Ctrl-C leaves the escrow open on-chain)…
  → Completed
  → Settled
Job #42 settled.
```

`run` exits `0` when the job settles and `1` when it is refunded or disputed, so
it drops straight into CI. Use `--no-wait` to return as soon as the escrow is
locked, or `--json` for machine-readable output.

## Check on a job

Reads need no key:

```bash
pulserun status 42 --contract "$PULSEESCROW_ID"
```

## Get your money back

If the runner never proves the job, refund the full budget once
`max_duration_secs` has passed:

```bash
pulserun cancel 42
```

If the job `Completed` but you believe the proof is wrong, challenge it inside
the dispute window:

```bash
pulserun dispute 42
```

Dispute freezes the payout. Resolution is handled by pulserun-core's dispute
path, not automatically — see
[Protocol mechanics](../protocol-mechanics.md#lifecycle).
