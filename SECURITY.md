# Security Policy

PulseRun Client holds the keys and the sandboxes for PulseRun's pay-per-run
compute protocol on Stellar. The CLI signs transactions that move funds in and
out of the `PulseEscrow` contract, and the daemon executes untrusted jobs. A bug
here can leak a signing key, submit a wrong proof, or escape a sandbox.

This code is **unaudited**. It is a reference implementation; commission an
independent review before it custodies real value.

## Supported versions

Security fixes land on `main` and are released through reviewed pull requests.
Use the latest `main` commit or the most recent tagged release. There is no
long-term-support branch — only the tip of `main` is maintained.

## Scope

In scope:

- The CLI under [`packages/cli/`](packages/cli/) — contract-call encoding, amount
  math, signer handling, `--json` output.
- The runner daemon under [`packages/daemon/`](packages/daemon/) — job discovery,
  the Docker sandbox and its limits, proof construction, payout claiming.
- Secret handling: `PULSERUN_SECRET_KEY` / `--key`, and anything that could log
  or persist a key.
- Sandbox isolation: CPU, memory and PID limits, `NetworkMode`, timeouts, and
  container cleanup.

Out of scope:

- The Soroban contracts themselves — those live in
  [pulserun-core](https://github.com/PulseRun-Labs/pulserun-core) and have their
  own security policy.
- Third-party wallets, RPC providers, and the Stellar network.
- Docker itself, or a host deliberately configured to run privileged containers.
- Issues in forked or unpublished deployments that diverge from `main`.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately through one of these channels:

1. **GitHub private vulnerability reporting (preferred)**
   [Open a private security advisory](https://github.com/PulseRun-Labs/pulserun-client/security/advisories/new).
2. **Email** `security@pulserun.com` with a description and reproduction.

Include:

- The affected package and file path.
- Steps to reproduce, including the network (testnet/mainnet) and contract ids
  if relevant.
- Impact assessment (key exposure, wrong proof, sandbox escape, fund loss).
- A proof of concept where possible, preferably against testnet.

## What to expect

- Acknowledgement within **72 hours**.
- Status updates as the report is triaged and remediated.
- Coordinated disclosure timing so users can patch before details are public.

## Safe harbour

We support good-faith research on **testnet** and local environments. Do not test
against mainnet funds you do not own, do not exfiltrate user data, and do not
degrade services you do not operate.

## Related documentation

- [Security model](README.md#security-model)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
