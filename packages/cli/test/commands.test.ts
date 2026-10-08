import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ComputeJob, PulseRunClient } from '../src/client/soroban.js';
import { emitJson, jsonReplacer, runCommand, runExitCode } from '../src/commands/run.js';
import { formatJob, statusCommand } from '../src/commands/status.js';
import { cancelCommand, claimCommand, disputeCommand } from '../src/commands/lifecycle.js';
import { buildProgram, formatError, isDirectExecution, main } from '../src/index.js';
import { createLogger } from '../src/ui.js';

const CONTRACT_ID = 'C'.padEnd(56, 'Z');
const TOKEN_ID = 'C'.padEnd(56, 'T');
const SECRET = Keypair.random().secret();
const ADDRESS = 'G'.padEnd(56, 'A');
const OTHER = 'G'.padEnd(56, 'B');

const SETTLED_JOB: ComputeJob = {
  jobId: 7n,
  requester: ADDRESS,
  runner: OTHER,
  paymentToken: TOKEN_ID,
  maxBudget: 15_000_000n,
  ratePerSecond: 1_000n,
  maxDurationSecs: 600,
  status: 'Settled',
  createdAt: 1_999_999_000,
  completedAt: 1_999_999_500,
  outputHash: `0x${'ab'.repeat(32)}`,
};

function collect(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

function fakeClient(overrides: Partial<Record<keyof PulseRunClient, unknown>> = {}) {
  return {
    createJob: vi.fn(async () => ({ jobId: 7n, txHash: 'tx-hash', ledger: 12 })),
    getJob: vi.fn(async () => SETTLED_JOB),
    getProof: vi.fn(async () => ({
      jobId: 7n,
      durationSecs: 20,
      exitCode: 0,
      outputHash: `0x${'ab'.repeat(32)}`,
    })),
    getDisputeWindow: vi.fn(async () => 3_600),
    waitForJob: vi.fn(async () => SETTLED_JOB),
    claimPayout: vi.fn(async () => ({ earnings: 900n, txHash: 'tx-hash', ledger: 13 })),
    disputeJob: vi.fn(async () => ({ txHash: 'tx-hash', ledger: 14 })),
    cancelUnclaimedJob: vi.fn(async () => ({ txHash: 'tx-hash', ledger: 15 })),
    ...overrides,
  } as unknown as PulseRunClient;
}

function silentLogger() {
  const out = collect();
  const err = collect();
  return {
    logger: createLogger({ color: false, stdout: out.stream, stderr: err.stream }),
    out: out.text,
    err: err.text,
  };
}

const baseOptions = {
  runner: OTHER,
  maxBudget: '1.5',
  rate: '0.001',
  token: TOKEN_ID,
  key: SECRET,
  contract: CONTRACT_ID,
};

describe('runCommand', () => {
  it('escrows a job and waits for settlement', async () => {
    const client = fakeClient();
    const sink = silentLogger();

    const result = await runCommand(baseOptions, { client, logger: sink.logger });

    expect(result.submission.jobId).toBe(7n);
    expect(result.job?.status).toBe('Settled');
    expect(client.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runner: OTHER,
        paymentToken: TOKEN_ID,
        maxBudget: 15_000_000n,
        ratePerSecond: 10_000n,
        maxDurationSecs: 3_600,
      }),
    );
    expect(sink.out()).toContain('Job #7 escrowed');
    expect(sink.out()).toContain('Settled');
  });

  it('returns immediately with --no-wait', async () => {
    const client = fakeClient();
    const result = await runCommand({ ...baseOptions, wait: false }, { client });

    expect(result.job).toBeNull();
    expect(client.waitForJob).not.toHaveBeenCalled();
    expect(runExitCode(result)).toBe(0);
  });

  it('emits JSON when asked and mixes no human output', async () => {
    const client = fakeClient();
    const sink = silentLogger();
    const stdout = collect();

    await runCommand(
      { ...baseOptions, json: true },
      { client, logger: sink.logger, stdout: stdout.stream },
    );

    const payload = JSON.parse(stdout.text());
    expect(payload.jobId).toBe('7');
    expect(payload.job.status).toBe('Settled');
    expect(payload.job.maxBudget).toBe('15000000');
    expect(sink.out()).toBe('');
  });

  it('validates inputs before any network call', async () => {
    const client = fakeClient();
    await expect(runCommand({ ...baseOptions, runner: ' ' }, { client })).rejects.toThrowError(
      /Missing --runner/,
    );
    await expect(
      runCommand({ ...baseOptions, maxBudget: 'nope' }, { client }),
    ).rejects.toThrowError(/Invalid amount/);
    expect(client.createJob).not.toHaveBeenCalled();
  });

  it('requires a contract, a key and a token', async () => {
    await expect(runCommand({ ...baseOptions, contract: undefined })).rejects.toThrowError(
      /Missing escrow contract ID/,
    );
    await expect(runCommand({ ...baseOptions, key: undefined })).rejects.toThrowError(
      /Missing Stellar secret key/,
    );
    await expect(runCommand({ ...baseOptions, token: undefined }, {})).rejects.toThrowError(
      /Missing payment token ID/,
    );
  });

  it('maps non-settled jobs to a non-zero exit code', () => {
    expect(
      runExitCode({ submission: { jobId: 1n, txHash: 'tx', ledger: 1 }, job: SETTLED_JOB }),
    ).toBe(0);
    expect(
      runExitCode({
        submission: { jobId: 1n, txHash: 'tx', ledger: 1 },
        job: { ...SETTLED_JOB, status: 'Refunded' },
      }),
    ).toBe(1);
    expect(runExitCode({ submission: { jobId: 1n, txHash: 'tx', ledger: 1 }, job: null })).toBe(0);
  });
});

describe('statusCommand', () => {
  it('renders a formatted job', async () => {
    const sink = silentLogger();
    const job = await statusCommand(
      7,
      { contract: CONTRACT_ID },
      { client: fakeClient(), logger: sink.logger, now: () => 1_999_999_600 },
    );

    expect(job.jobId).toBe(7n);
    expect(sink.out()).toContain('Job #7');
    expect(sink.out()).toContain('Settled');
    expect(sink.out()).toContain(`0x${'ab'.repeat(32)}`);
  });

  it('emits JSON on stdout when --json is passed', async () => {
    const stdout = collect();
    const sink = silentLogger();
    await statusCommand(
      7,
      { contract: CONTRACT_ID, json: true },
      {
        client: fakeClient(),
        logger: sink.logger,
        stdout: stdout.stream,
        now: () => 1_999_999_600,
      },
    );

    const payload = JSON.parse(stdout.text());
    expect(payload.job.status).toBe('Settled');
    expect(payload.proof.durationSecs).toBe(20);
    expect(sink.out()).toBe('');
  });

  it('warns about refunded jobs', async () => {
    const sink = silentLogger();
    await statusCommand(
      7,
      { contract: CONTRACT_ID },
      {
        client: fakeClient({ getJob: vi.fn(async () => ({ ...SETTLED_JOB, status: 'Refunded' })) }),
        logger: sink.logger,
        now: () => 1_999_999_600,
      },
    );
    expect(sink.err()).toContain('was refunded');
  });

  it('rejects malformed job ids', async () => {
    await expect(
      statusCommand('abc', { contract: CONTRACT_ID }, { client: fakeClient() }),
    ).rejects.toThrowError(/Invalid job id/);
  });
});

describe('formatJob', () => {
  it('shows a friendly expiry for queued jobs', () => {
    const rendered = formatJob(
      { ...SETTLED_JOB, status: 'Queued', createdAt: 1_999_999_000, maxDurationSecs: 120 },
      null,
      1_999_999_000,
    );
    expect(rendered).toContain('2m 00s left');
    expect(rendered).toMatch(/Status\s+Queued/);
  });
});

describe('lifecycle commands', () => {
  it('claims a payout', async () => {
    const client = fakeClient();
    const sink = silentLogger();
    const result = await claimCommand(7, {}, { client, logger: sink.logger });
    expect(result.earnings).toBe(900n);
    expect(sink.out()).toContain('Job #7 settled');
  });

  it('disputes a job', async () => {
    const client = fakeClient();
    const sink = silentLogger();
    await disputeCommand(7, {}, { client, logger: sink.logger });
    expect(sink.err()).toContain('disputed');
  });

  it('cancels an unclaimed job', async () => {
    const client = fakeClient();
    const sink = silentLogger();
    await cancelCommand(7, {}, { client, logger: sink.logger });
    expect(sink.out()).toContain('refunded');
  });

  it('emits JSON for claims', async () => {
    const stdout = collect();
    await claimCommand(7, { json: true }, { client: fakeClient(), stdout: stdout.stream });
    expect(JSON.parse(stdout.text()).earnings).toBe('900');
  });
});

describe('json helpers', () => {
  it('serialises bigints as strings', () => {
    expect(JSON.stringify({ id: 10n }, jsonReplacer)).toBe('{"id":"10"}');
  });

  it('emits indented JSON with a trailing newline', () => {
    const stdout = collect();
    emitJson(stdout.stream, { jobId: '7' });
    expect(stdout.text()).toBe('{\n  "jobId": "7"\n}\n');
  });
});

describe('CLI wiring', () => {
  it('registers every command', () => {
    const names = buildProgram().commands.map((command) => command.name());
    expect(names).toEqual(['run', 'status', 'claim', 'dispute', 'cancel']);
  });

  it('returns 0 when help is requested', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(main(['node', 'pulserun', '--help'])).resolves.toBe(0);
      expect(out).toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('returns a non-zero code for unknown commands', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(main(['node', 'pulserun', 'nope'])).resolves.toBeGreaterThan(0);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('formats errors for the terminal', () => {
    expect(formatError(new Error('boom'))).toBe('pulserun: boom');
    expect(formatError('boom')).toBe('pulserun: boom');
  });

  it('does not treat an unrelated argv as a direct execution', () => {
    expect(isDirectExecution(['node', '/tmp/not-the-cli.js'])).toBe(false);
    expect(isDirectExecution(['node'])).toBe(false);
  });
});
