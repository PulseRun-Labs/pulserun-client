import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/config.js';
import type { ComputeJob, ExecutionProofRecord } from '../src/contract.js';
import { hashLogs } from '../src/proof.js';
import { jobSpecMessage } from '../src/specs.js';
import { formatVerification, verificationExitCode, verifyExecution } from '../src/verify.js';
import { type VerifyArgs, main, parseVerifyArgs, verifyCommand } from '../src/verify-cli.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 8));
const REQUESTER_KEY = Keypair.random();
const REQUESTER = REQUESTER_KEY.publicKey();
const OTHER = Keypair.random().publicKey();
const JOB_ID = 7n;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulserun-verify-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<ComputeJob> = {}): ComputeJob {
  return {
    jobId: JOB_ID,
    requester: REQUESTER,
    runner: OTHER,
    paymentToken: TOKEN,
    maxBudget: 15_000_000n,
    ratePerSecond: 1_000n,
    maxDurationSecs: 600,
    status: 'Completed',
    createdAt: 1_999_999_000,
    completedAt: 1_999_999_500,
    outputHash: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

function makeProof(overrides: Partial<ExecutionProofRecord> = {}): ExecutionProofRecord {
  return {
    jobId: JOB_ID,
    durationSecs: 20,
    exitCode: 0,
    outputHash: `0x${hashLogs('ok')}`,
    ...overrides,
  };
}

function fakeExecutor(result: { logs: string; exitCode: number; timedOut?: boolean }) {
  return {
    execute: vi.fn(async () => ({
      jobId: JOB_ID,
      exitCode: result.exitCode,
      logs: result.logs,
      durationMs: 12_400,
      timedOut: result.timedOut ?? false,
      oomKilled: false,
    })),
  };
}

function loggerSpy(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

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

async function writeSignedSpec(
  job: ComputeJob,
  spec = { image: 'alpine', command: 'true' },
): Promise<string> {
  const signature = Buffer.from(
    REQUESTER_KEY.sign(
      Buffer.from(
        jobSpecMessage({
          jobId: job.jobId,
          requester: REQUESTER,
          image: spec.image,
          command: spec.command,
        }),
        'utf8',
      ),
    ),
  ).toString('base64');
  const path = join(dir, 'jobs.json');
  await writeFile(
    path,
    JSON.stringify({ [job.jobId.toString()]: { ...spec, signer: REQUESTER, signature } }),
    'utf8',
  );
  return path;
}

function fakeEscrow(job: ComputeJob, proof: ExecutionProofRecord | null) {
  return { getJob: vi.fn(async () => job), getProof: vi.fn(async () => proof) };
}

/** Builds a complete `VerifyArgs` with the flag defaults applied. */
function verifyArgs(overrides: Partial<VerifyArgs> = {}): VerifyArgs {
  return { json: false, help: false, version: false, ...overrides };
}

function verifierEnv(specsPath: string): NodeJS.ProcessEnv {
  return {
    PULSEESCROW_ID: CONTRACT_ID,
    PULSERUN_NETWORK: 'testnet',
    PULSERUN_JOB_SPECS_FILE: specsPath,
  };
}

describe('verifyExecution', () => {
  const spec = { image: 'alpine', command: 'true' };

  it('verifies a re-run that reproduces the digest and exit code', async () => {
    const result = await verifyExecution(
      { job: makeJob(), proof: makeProof(), spec, timeoutSeconds: 60 },
      { executor: fakeExecutor({ logs: 'ok', exitCode: 0 }) },
    );

    expect(result.verified).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.actual.outputHash).toBe(hashLogs('ok'));
    expect(verificationExitCode(result)).toBe(0);
  });

  it('reports a digest mismatch without throwing', async () => {
    const result = await verifyExecution(
      { job: makeJob(), proof: makeProof(), spec, timeoutSeconds: 60 },
      { executor: fakeExecutor({ logs: 'a different run', exitCode: 0 }) },
    );

    expect(result.verified).toBe(false);
    expect(result.reasons).toContainEqual(expect.stringContaining('output hash'));
    expect(verificationExitCode(result)).toBe(1);
    expect(formatVerification(result)).toContain('not reproduced');
  });

  it('reports an exit-code mismatch and a timed-out re-run', async () => {
    const exitMismatch = await verifyExecution(
      { job: makeJob(), proof: makeProof({ exitCode: 3 }), spec, timeoutSeconds: 60 },
      { executor: fakeExecutor({ logs: 'ok', exitCode: 0 }) },
    );
    expect(exitMismatch.verified).toBe(false);
    expect(exitMismatch.reasons).toContainEqual(expect.stringContaining('exit code'));

    const timedOut = await verifyExecution(
      { job: makeJob(), proof: makeProof({ exitCode: 124 }), spec, timeoutSeconds: 1 },
      { executor: fakeExecutor({ logs: 'ok', exitCode: 124, timedOut: true }) },
    );
    expect(timedOut.verified).toBe(false);
    expect(timedOut.reasons).toContainEqual(expect.stringContaining('verification timeout'));
  });
});

describe('parseVerifyArgs', () => {
  it('parses the job id, flags and inline values', () => {
    expect(
      parseVerifyArgs(['42', '--specs', './jobs.json', '--json', '--network=mainnet']),
    ).toEqual({
      jobId: '42',
      specs: './jobs.json',
      network: 'mainnet',
      json: true,
      help: false,
      version: false,
    });
  });

  it('rejects unknown flags, missing values and extra positionals', () => {
    expect(() => parseVerifyArgs(['42', '--nope'])).toThrowError(/Unknown argument/);
    expect(() => parseVerifyArgs(['42', '--specs'])).toThrowError(/requires a value/);
    expect(() => parseVerifyArgs(['42', '43'])).toThrowError(/Expected one job id/);
  });
});

describe('verifyCommand', () => {
  it('verifies a job using the requester-signed spec', async () => {
    const job = makeJob();
    const path = await writeSignedSpec(job);
    const logger = loggerSpy();
    const stdout = collect();

    const outcome = await verifyCommand(verifyArgs({ jobId: '7', json: true }), {
      env: verifierEnv(path),
      escrow: fakeEscrow(job, makeProof()),
      executor: fakeExecutor({ logs: 'ok', exitCode: 0 }),
      logger,
      stdout: stdout.stream,
    });

    expect(outcome.result.verified).toBe(true);
    expect(outcome.signatureChecked).toBe(true);
    const payload = JSON.parse(stdout.text());
    expect(payload.jobId).toBe('7');
    expect(payload.verified).toBe(true);
  });

  it('refuses a spec that the requester did not sign', async () => {
    const job = makeJob();
    const path = join(dir, 'unsigned.json');
    await writeFile(path, JSON.stringify({ '7': { image: 'alpine', command: 'true' } }), 'utf8');
    const executor = fakeExecutor({ logs: 'ok', exitCode: 0 });

    await expect(
      verifyCommand(verifyArgs({ jobId: '7' }), {
        env: verifierEnv(path),
        escrow: fakeEscrow(job, makeProof()),
        executor,
        logger: loggerSpy(),
      }),
    ).rejects.toThrowError(/not signed by requester/);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('explains a missing spec and a missing proof', async () => {
    const job = makeJob();
    await expect(
      verifyCommand(verifyArgs({ jobId: '7' }), {
        env: verifierEnv(join(dir, 'nothing.json')),
        escrow: fakeEscrow(job, makeProof()),
        executor: fakeExecutor({ logs: 'ok', exitCode: 0 }),
        logger: loggerSpy(),
      }),
    ).rejects.toThrowError(/No spec for job #7/);

    await expect(
      verifyCommand(verifyArgs({ jobId: '7' }), {
        env: verifierEnv(join(dir, 'nothing.json')),
        escrow: fakeEscrow(job, null),
        logger: loggerSpy(),
      }),
    ).rejects.toThrowError(/no proof on-chain/);
  });

  it('reproduces from operator flags without claiming a signature check', async () => {
    const logger = loggerSpy();
    const outcome = await verifyCommand(verifyArgs({ jobId: '7', image: 'alpine', cmd: 'true' }), {
      env: verifierEnv(join(dir, 'nothing.json')),
      escrow: fakeEscrow(makeJob(), makeProof()),
      executor: fakeExecutor({ logs: 'ok', exitCode: 0 }),
      logger,
    });

    expect(outcome.signatureChecked).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('--image/--cmd'));
  });
});

describe('verifier CLI', () => {
  function deps(path: string, proof: ExecutionProofRecord | null = makeProof()) {
    return {
      env: verifierEnv(path),
      escrow: fakeEscrow(makeJob(), proof),
      executor: fakeExecutor({ logs: 'ok', exitCode: 0 }),
      logger: loggerSpy(),
    };
  }

  it('exits 0 when the proof is reproduced and 1 when it is not', async () => {
    const path = await writeSignedSpec(makeJob());
    await expect(main({ argv: ['7'], ...deps(path) })).resolves.toBe(0);

    const mismatch = {
      ...deps(path),
      executor: fakeExecutor({ logs: 'tampered', exitCode: 0 }),
    };
    await expect(main({ argv: ['7'], ...mismatch })).resolves.toBe(1);
  });

  it('exits 2 when verification cannot run', async () => {
    await expect(main({ argv: ['7'], ...deps(join(dir, 'none.json')) })).resolves.toBe(2);
    await expect(main({ argv: ['7'], ...deps(join(dir, 'none.json'), null) })).resolves.toBe(2);
    await expect(main({ argv: [], ...deps(join(dir, 'none.json')) })).resolves.toBe(2);
    await expect(main({ argv: ['7', '--nope'], ...deps(join(dir, 'none.json')) })).resolves.toBe(2);
  });

  it('prints usage and version', async () => {
    const out = collect();
    await expect(main({ argv: ['--help'], stdout: out.stream })).resolves.toBe(0);
    expect(out.text()).toContain('pulserun-verify');

    const version = collect();
    await expect(main({ argv: ['--version'], stdout: version.stream })).resolves.toBe(0);
    expect(version.text().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
