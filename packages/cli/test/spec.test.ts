import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PulseRunClient, PulseRunError } from '../src/client/soroban.js';
import { jobSpecMessage, signJobSpec } from '../src/client/spec.js';
import { runCommand } from '../src/commands/run.js';

const SECRET = Keypair.random().secret();
const REQUESTER = Keypair.fromSecret(SECRET);
const OTHER = Keypair.random().publicKey();
const CONTRACT_ID = 'C'.padEnd(56, 'Z');
const TOKEN_ID = 'C'.padEnd(56, 'T');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulserun-cli-spec-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeClient(): PulseRunClient {
  return {
    createJob: vi.fn(async () => ({ jobId: 7n, txHash: 'tx-hash', ledger: 12 })),
    getDisputeWindow: vi.fn(async () => 3_600),
    waitForJob: vi.fn(async () => null),
  } as unknown as PulseRunClient;
}

describe('jobSpecMessage', () => {
  it('is the documented single-line canonical form', () => {
    expect(
      jobSpecMessage({
        jobId: 42n,
        requester: 'GABC',
        image: 'node:22-alpine',
        command: 'pnpm test',
      }),
    ).toBe(
      '{"domain":"pulserun-job-spec","version":1,"jobId":"42","requester":"GABC","image":"node:22-alpine","command":"pnpm test"}',
    );
  });
});

describe('signJobSpec', () => {
  it('signs with the requester and verifies against its public key', () => {
    const content = {
      jobId: 7n,
      requester: REQUESTER.publicKey(),
      image: 'alpine',
      command: 'true',
    };
    const signed = signJobSpec(REQUESTER, content);

    expect(signed.signer).toBe(content.requester);
    expect(
      Keypair.fromPublicKey(content.requester).verify(
        Buffer.from(jobSpecMessage(content), 'utf8'),
        Buffer.from(signed.signature, 'base64'),
      ),
    ).toBe(true);
  });

  it('refuses to sign a spec for a job funded by another address', () => {
    expect(() =>
      signJobSpec(REQUESTER, { jobId: 7n, requester: OTHER, image: 'alpine', command: 'true' }),
    ).toThrowError(PulseRunError);
  });
});

describe('runCommand --spec-out', () => {
  it('writes a spec signed by the requester', async () => {
    const path = join(dir, 'jobs.json');

    await runCommand(
      {
        runner: OTHER,
        maxBudget: '1.5',
        rate: '0.001',
        token: TOKEN_ID,
        key: SECRET,
        contract: CONTRACT_ID,
        image: ' node:22-alpine ',
        cmd: ' pnpm test ',
        specOut: path,
        wait: false,
      },
      { client: fakeClient() },
    );

    const entries = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      { image: string; command: string; signer: string; signature: string }
    >;
    const entry = entries['7'];
    expect(entry).toBeDefined();
    expect(entry?.image).toBe('node:22-alpine');
    expect(entry?.command).toBe('pnpm test');
    expect(entry?.signer).toBe(REQUESTER.publicKey());
    expect(
      Keypair.fromPublicKey(REQUESTER.publicKey()).verify(
        Buffer.from(
          jobSpecMessage({
            jobId: 7n,
            requester: REQUESTER.publicKey(),
            image: 'node:22-alpine',
            command: 'pnpm test',
          }),
          'utf8',
        ),
        Buffer.from(entry?.signature ?? '', 'base64'),
      ),
    ).toBe(true);
  });

  it('requires both --image and --cmd', async () => {
    await expect(
      runCommand(
        {
          runner: OTHER,
          maxBudget: '1.5',
          rate: '0.001',
          token: TOKEN_ID,
          key: SECRET,
          contract: CONTRACT_ID,
          image: 'alpine',
          specOut: join(dir, 'jobs.json'),
          wait: false,
        },
        { client: fakeClient() },
      ),
    ).rejects.toThrowError(/requires both --image and --cmd/);
  });
});
