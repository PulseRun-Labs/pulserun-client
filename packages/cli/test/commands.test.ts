import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord, PulseRunClient } from '../src/client/soroban.js';
import { emitJson, jsonReplacer, runCommand, runExitCode } from '../src/commands/run.js';
import { formatJob, statusCommand } from '../src/commands/status.js';
import { buildProgram, formatError, isDirectExecution, main } from '../src/index.js';
import { createLogger } from '../src/ui.js';

const CONTRACT_ID = 'C'.padEnd(56, 'Z');
const SECRET = Keypair.random().secret();
const ADDRESS = 'G'.padEnd(56, 'A');

const COMPLETED_JOB: JobRecord = {
  id: 7n,
  client: ADDRESS,
  runner: ADDRESS,
  image: 'node:22-alpine',
  command: 'pnpm test',
  maxBudgetStroops: 15_000_000n,
  deadline: 2_000_000_000,
  createdAt: 1_999_999_000,
  status: 'Completed',
  outputHash: `0x${'ab'.repeat(32)}`,
  exitCode: 0,
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
    getJob: vi.fn(async () => COMPLETED_JOB),
    waitForJob: vi.fn(async () => COMPLETED_JOB),
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

describe('runCommand', () => {
  const baseOptions = {
    image: 'node:22-alpine',
    cmd: 'pnpm test',
    maxBudget: '1.5',
    key: SECRET,
    contract: CONTRACT_ID,
  };

  it('escrows a job and waits for the proof', async () => {
    const client = fakeClient();
    const sink = silentLogger();

    const result = await runCommand(baseOptions, { client, logger: sink.logger });

    expect(result.submission.jobId).toBe(7n);
    expect(result.job?.status).toBe('Completed');
    expect(client.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'node:22-alpine',
        command: 'pnpm test',
        maxBudgetXlm: '1.5',
      }),
    );
    expect(sink.out()).toContain('Job #7 escrowed');
    expect(sink.out()).toContain('Completed');
  });

  it('returns immediately with --no-wait', async () => {
    const client = fakeClient();
    const sink = silentLogger();

    const result = await runCommand(
      { ...baseOptions, wait: false },
      { client, logger: sink.logger },
    );

    expect(result.job).toBeNull();
    expect(client.waitForJob).not.toHaveBeenCalled();
    expect(runExitCode(result)).toBe(0);
  });

  it('emits JSON when asked', async () => {
    const client = fakeClient();
    const sink = silentLogger();
    const stdout = collect();

    await runCommand(
      { ...baseOptions, json: true },
      { client, logger: sink.logger, stdout: stdout.stream },
    );

    const payload = JSON.parse(stdout.text());
    expect(payload.jobId).toBe('7');
    expect(payload.job.status).toBe('Completed');
    expect(payload.job.maxBudgetXlm).toBe('1.5');
    // JSON mode must not mix in human output.
    expect(sink.out()).toBe('');
  });

  it('validates required inputs before any network call', async () => {
    const client = fakeClient();
    await expect(runCommand({ ...baseOptions, image: ' ' }, { client })).rejects.toThrowError(
      /Missing --image/,
    );
    await expect(runCommand({ ...baseOptions, cmd: '' }, { client })).rejects.toThrowError(
      /Missing --cmd/,
    );
    await expect(
      runCommand({ ...baseOptions, maxBudget: 'nope' }, { client }),
    ).rejects.toThrowError(/Invalid XLM amount/);
    expect(client.createJob).not.toHaveBeenCalled();
  });

  it('requires a contract and a key', async () => {
    await expect(runCommand({ ...baseOptions, contract: undefined })).rejects.toThrowError(
      /Missing escrow contract ID/,
    );
    await expect(runCommand({ ...baseOptions, key: undefined })).rejects.toThrowError(
      /Missing Stellar secret key/,
    );
  });

  it('maps failed jobs to a non-zero exit code', () => {
    expect(
      runExitCode({
        submission: { jobId: 1n, txHash: 'tx', ledger: 1 },
        job: { ...COMPLETED_JOB, status: 'Failed', exitCode: 1 },
      }),
    ).toBe(1);
    expect(runExitCode({ submission: { jobId: 1n, txHash: 'tx', ledger: 1 }, job: null })).toBe(0);
  });
});

describe('statusCommand', () => {
  it('renders a formatted job', async () => {
    const sink = silentLogger();
    const json = await statusCommand(
      7,
      { contract: CONTRACT_ID },
      {
        client: fakeClient(),
        logger: sink.logger,
        now: () => 1_999_999_000,
      },
    );

    expect(json.jobId).toBe('7');
    expect(sink.out()).toContain('Job #7');
    expect(sink.out()).toContain('1.5 XLM');
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
        now: () => 1_999_999_000,
      },
    );

    expect(JSON.parse(stdout.text()).status).toBe('Completed');
    expect(sink.out()).toBe('');
  });

  it('warns about unfinished and failed jobs', async () => {
    const running = silentLogger();
    await statusCommand(
      7,
      { contract: CONTRACT_ID },
      {
        client: fakeClient({
          getJob: vi.fn(async () => ({ ...COMPLETED_JOB, status: 'Running' })),
        }),
        logger: running.logger,
        now: () => 1_999_999_000,
      },
    );
    expect(running.out()).toContain('Still running');

    const failed = silentLogger();
    await statusCommand(
      7,
      { contract: CONTRACT_ID },
      {
        client: fakeClient({
          getJob: vi.fn(async () => ({ ...COMPLETED_JOB, status: 'Expired' })),
        }),
        logger: failed.logger,
        now: () => 1_999_999_000,
      },
    );
    expect(failed.err()).toContain('finished as Expired');
  });

  it('rejects malformed job ids', async () => {
    await expect(
      statusCommand('abc', { contract: CONTRACT_ID }, { client: fakeClient() }),
    ).rejects.toThrowError(/Invalid job id/);
  });
});

describe('formatJob', () => {
  it('shows a friendly duration for the deadline', () => {
    const rendered = formatJob({ ...COMPLETED_JOB, deadline: 1_999_999_120 }, 1_999_999_000);
    expect(rendered).toContain('2m 00s left');
    expect(rendered).toMatch(/Command\s+pnpm test/);
  });

  it('shows overdue deadlines as negative relative time', () => {
    const rendered = formatJob({ ...COMPLETED_JOB, deadline: 1_999_998_970 }, 1_999_999_000);
    expect(rendered).toContain('30s ago');
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
  it('registers the run and status commands', () => {
    const names = buildProgram().commands.map((command) => command.name());
    expect(names).toEqual(['run', 'status']);
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
