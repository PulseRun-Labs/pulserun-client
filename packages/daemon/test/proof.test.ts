import { Account, Keypair, StrKey, rpc } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { DaemonError } from '../src/config.js';
import {
  type ProofRpcServer,
  SorobanProofSubmitter,
  buildProof,
  formatProof,
  hashLogs,
  hexToBytes,
  normaliseHash,
  outputHashBytes,
} from '../src/proof.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));
const SECRET = Keypair.random().secret();
const RUNNER = Keypair.fromSecret(SECRET).publicKey();
const HASH = 'ab'.repeat(32);

function createFakeServer(overrides: { status?: string; sendStatus?: string } = {}) {
  const server: ProofRpcServer = {
    getAccount: vi.fn(async (address: string) => new Account(address, '5')),
    prepareTransaction: vi.fn(async (tx) => tx),
    sendTransaction: vi.fn(
      async () =>
        ({ status: overrides.sendStatus ?? 'PENDING', hash: 'tx'.padEnd(64, '0') }) as never,
    ),
    pollTransaction: vi.fn(
      async () =>
        ({
          status: overrides.status ?? rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 99,
        }) as rpc.Api.GetTransactionResponse,
    ),
  };
  return server;
}

describe('hashLogs', () => {
  it('matches the well-known SHA-256 vectors', () => {
    expect(hashLogs('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashLogs('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes bytes and strings identically', () => {
    expect(hashLogs(Buffer.from('hello'))).toBe(hashLogs('hello'));
  });

  it('produces a 32-byte digest', () => {
    expect(outputHashBytes('hello')).toHaveLength(32);
    expect(outputHashBytes('hello')).toBeInstanceOf(Uint8Array);
  });
});

describe('normaliseHash', () => {
  it('accepts prefixed and bare digests', () => {
    expect(normaliseHash(HASH)).toBe(HASH);
    expect(normaliseHash(`0x${HASH.toUpperCase()}`)).toBe(HASH);
    expect(normaliseHash(` ${HASH} `)).toBe(HASH);
  });

  it('rejects anything that is not a 32-byte digest', () => {
    expect(() => normaliseHash('deadbeef')).toThrowError(DaemonError);
    expect(() => normaliseHash('zz'.repeat(32))).toThrowError(/not a 32-byte SHA-256 hex digest/);
  });

  it('converts hex into bytes', () => {
    expect([...hexToBytes(`${'00'.repeat(31)}ff`)].slice(-2)).toEqual([0x00, 0xff]);
    expect(hexToBytes(HASH)).toHaveLength(32);
    expect([...hexToBytes(`0x${'00'.repeat(31)}0a`)].at(-1)).toBe(0x0a);
    // Round-trips with the bytes used for the on-chain BytesN<32> argument.
    expect(Buffer.from(outputHashBytes('hello')).toString('hex')).toBe(hashLogs('hello'));
  });
});

describe('buildProof', () => {
  it('marks a clean exit as success', () => {
    const proof = buildProof({ exitCode: 0, logs: 'ok' });
    expect(proof).toEqual({ outputHash: hashLogs('ok'), exitCode: 0, success: true });
  });

  it('fails on a non-zero exit code', () => {
    expect(buildProof({ exitCode: 1, logs: 'boom' }).success).toBe(false);
  });

  it('fails when the sandbox timed out even with a zero exit code', () => {
    const proof = buildProof({ exitCode: 0, logs: 'partial', timedOut: true });
    expect(proof.success).toBe(false);
  });

  it('formats a compact one-line summary', () => {
    expect(formatProof(12n, { outputHash: HASH, exitCode: 0, success: true })).toBe(
      '#12 sha256:abababababab… exit 0 ✓',
    );
    expect(formatProof(12n, { outputHash: HASH, exitCode: 3, success: false })).toContain(
      'exit 3 ✗',
    );
  });
});

describe('SorobanProofSubmitter', () => {
  function createSubmitter(server: ProofRpcServer) {
    return new SorobanProofSubmitter({
      rpcUrl: 'https://example.test',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractId: CONTRACT_ID,
      secretKey: SECRET,
      server,
    });
  }

  it('requires a contract id', () => {
    expect(
      () =>
        new SorobanProofSubmitter({
          rpcUrl: 'https://example.test',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractId: '',
          secretKey: SECRET,
        }),
    ).toThrowError(/contract ID is required/);
  });

  it('signs with the runner key derived from the secret', () => {
    const submitter = createSubmitter(createFakeServer());
    expect(submitter.publicKey).toBe(RUNNER);
  });

  it('submits a proof and returns the transaction receipt', async () => {
    const server = createFakeServer();
    const submitter = createSubmitter(server);

    const submission = await submitter.submit({
      jobId: 7n,
      outputHash: `0x${HASH}`,
      exitCode: 0,
      success: true,
    });

    expect(submission).toEqual({ txHash: 'tx'.padEnd(64, '0'), ledger: 99, outputHash: HASH });
    expect(server.prepareTransaction).toHaveBeenCalledOnce();
    expect(server.sendTransaction).toHaveBeenCalledOnce();
  });

  it('rejects exit codes outside i32', async () => {
    const submitter = createSubmitter(createFakeServer());
    await expect(
      submitter.submit({ jobId: 1n, outputHash: HASH, exitCode: 2 ** 40, success: false }),
    ).rejects.toThrowError(/not a signed 32-bit integer/);
  });

  it('rejects a malformed output hash before hitting the network', async () => {
    const server = createFakeServer();
    const submitter = createSubmitter(server);
    await expect(
      submitter.submit({ jobId: 1n, outputHash: 'nope', exitCode: 0, success: true }),
    ).rejects.toThrowError(/not a 32-byte/);
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it('surfaces a rejected transaction', async () => {
    const submitter = createSubmitter(createFakeServer({ sendStatus: 'ERROR' }));
    await expect(
      submitter.submit({ jobId: 1n, outputHash: HASH, exitCode: 0, success: true }),
    ).rejects.toThrowError(/rejected submit_proof/);
  });

  it('surfaces an unconfirmed transaction', async () => {
    const submitter = createSubmitter(
      createFakeServer({ status: rpc.Api.GetTransactionStatus.FAILED }),
    );
    await expect(
      submitter.submit({ jobId: 1n, outputHash: HASH, exitCode: 0, success: true }),
    ).rejects.toThrowError(/submit_proof did not confirm/);
  });

  it('encodes a failure proof without throwing', async () => {
    const submitter = createSubmitter(createFakeServer());
    await expect(
      submitter.submit({ jobId: 9n, outputHash: HASH, exitCode: 137, success: false }),
    ).resolves.toMatchObject({ outputHash: HASH });
  });
});
