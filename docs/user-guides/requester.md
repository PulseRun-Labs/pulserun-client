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
  --image node@sha256:… \
  --cmd "pnpm test" \
  --spec-out ./jobs.json \
  --network testnet
```

`--image`, `--cmd` and `--spec-out` record the workload in a local spec file,
signed with your requester key. A runner only executes a spec whose signature
verifies against your address, so the command cannot be swapped by whoever can
write that file. Pin the image by digest if you want the job to be verifiable.

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

## Check the proof yourself

Before you dispute, reproduce the job. `pulserun-verify` re-runs the signed spec
under the same sandbox limits and compares the digest and exit code with the
proof on-chain. It needs no key:

```bash
export PULSEESCROW_ID=C...
export PULSERUN_JOB_SPECS_FILE=./jobs.json
pulserun-verify 42
```

Exit code `0` means reproduced, `1` means the re-run differed, and `2` means the
check could not run. A `1` is evidence to bring to a dispute, not a verdict:
non-deterministic output cannot be reproduced by anyone. See
[Verifying a proof](../verification.md).
