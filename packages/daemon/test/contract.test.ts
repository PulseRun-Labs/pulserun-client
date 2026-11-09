import { Account, Keypair, StrKey, nativeToScVal, rpc, scValToNative } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { DaemonError } from '../src/config.js';
import {
  type ContractRpcServer,
  CONTRACT_METHODS,
  RunnerEscrow,
  decodeComputeJob,
  decodeExecutionProof,
  decodeJobStatus,
  encodeExecutionProof,
  toOutputHashBytes,
} from '../src/contract.js';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));
const SECRET = Keypair.random().secret();
const RUNNER = Keypair.fromSecret(SECRET).publicKey();
const REQUESTER = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 5));

function jobFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 7n,
    requester: REQUESTER,
    runner: RUNNER,
    payment_token: TOKEN,
    max_budget: 15_000_000n,
    rate_per_second: 1_000n,
    max_duration_secs: 600n,
    status: 0,
    created_at: 1_999_999_000n,
    completed_at: 0n,
    output_hash: new Uint8Array(32),
    ...overrides,
  };
}

interface FakeServerOptions {
  retval?: unknown;
  simulateError?: string;
  sendStatus?: string;
  txStatus?: string;
  returnValue?: unknown;
}

function createFakeServer(options: FakeServerOptions = {}): ContractRpcServer {
  const hash = 'a'.repeat(64);
  return {
    getAccount: vi.fn(async (address: string) => new Account(address, '5')),
    prepareTransaction: vi.fn(async (tx) => tx),
    sendTransaction: vi.fn(
      async () => ({ status: options.sendStatus ?? 'PENDING', hash }) as never,
    ),
    pollTransaction: vi.fn(
      async () =>
        ({
          status: options.txStatus ?? rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 99,
          returnValue: options.returnValue ?? nativeToScVal(0n, { type: 'i128' }),
        }) as rpc.Api.GetTransactionResponse,
    ),
    simulateTransaction: vi.fn(async () => {
      if (options.simulateError) return { error: options.simulateError } as never;
      return {
        transactionData: {},
        result: { retval: options.retval ?? nativeToScVal(jobFields()) },
        latestLedger: 1,
      } as unknown as rpc.Api.SimulateTransactionResponse;
    }),
  };
}

function createEscrow(server: ContractRpcServer, secretKey: string | null = SECRET) {
  return new RunnerEscrow({
    rpcUrl: 'https://example.test',
    networkPassphrase: 'Test SDF Network ; September 2015',
    contractId: CONTRACT_ID,
    ...(secretKey ? { secretKey } : {}),
    server,
  });
}

describe('decoders', () => {
  it('maps JobStatus discriminants and symbols', () => {
    expect(decodeJobStatus(0)).toBe('Queued');
    expect(decodeJobStatus(1)).toBe('Completed');
    expect(decodeJobStatus('refunded')).toBe('Refunded');
    expect(() => decodeJobStatus(42)).toThrowError(/Unknown job status/);
  });

  it('maps ComputeJob fields', () => {
    const job = decodeComputeJob(jobFields({ status: 2 }));
    expect(job.jobId).toBe(7n);
    expect(job.requester).toBe(REQUESTER);
    expect(job.paymentToken).toBe(TOKEN);
    expect(job.maxBudget).toBe(15_000_000n);
    expect(job.ratePerSecond).toBe(1_000n);
    expect(job.maxDurationSecs).toBe(600);
    expect(job.status).toBe('Disputed');
  });

  it('rejects non-object payloads', () => {
    expect(() => decodeComputeJob('nope')).toThrowError(DaemonError);
  });

  it('maps ExecutionProof fields', () => {
    const proof = decodeExecutionProof({
      job_id: 7n,
      duration_secs: 20,
      exit_code: 0,
      output_hash: new Uint8Array(32).fill(0xab),
    });
    expect(proof).toEqual({
      jobId: 7n,
      durationSecs: 20,
      exitCode: 0,
      outputHash: `0x${'ab'.repeat(32)}`,
    });
  });
});

describe('encodeExecutionProof', () => {
  it('encodes a symbol-keyed map', () => {
    const native = scValToNative(
      encodeExecutionProof({
        jobId: 7n,
        durationSecs: 20,
        exitCode: 3,
        outputHash: 'ab'.repeat(32),
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(native).sort()).toEqual([
      'duration_secs',
      'exit_code',
      'job_id',
      'output_hash',
    ]);
    expect(native['exit_code']).toBe(3);
    expect(native['output_hash']).toHaveLength(32);
  });

  it('rejects bad exit codes, durations and hashes', () => {
    expect(() =>
      encodeExecutionProof({
        jobId: 1n,
        durationSecs: 1,
        exitCode: 2 ** 40,
        outputHash: 'ab'.repeat(32),
      }),
    ).toThrowError(/signed 32-bit integer/);
    expect(() =>
      encodeExecutionProof({
        jobId: 1n,
        durationSecs: 0,
        exitCode: 0,
        outputHash: 'ab'.repeat(32),
      }),
    ).toThrowError(/whole number of seconds > 0/);
    expect(() => toOutputHashBytes('nope')).toThrowError(/32 bytes/);
  });
});

describe('RunnerEscrow', () => {
  it('requires a contract id', () => {
    expect(
      () =>
        new RunnerEscrow({
          rpcUrl: 'https://example.test',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractId: '',
          secretKey: SECRET,
        }),
    ).toThrowError(/contract ID is required/);
  });

  it('signs with the runner key derived from the secret', () => {
    expect(createEscrow(createFakeServer()).publicKey).toBe(RUNNER);
  });

  it('reads job_count, get_job and dispute_window', async () => {
    const countServer = createFakeServer({ retval: nativeToScVal(5n, { type: 'u64' }) });
    await expect(createEscrow(countServer).jobCount()).resolves.toBe(5n);

    const jobServer = createFakeServer({ retval: nativeToScVal(jobFields({ status: 1 })) });
    await expect(createEscrow(jobServer).getJob(7n)).resolves.toMatchObject({
      jobId: 7n,
      status: 'Completed',
    });

    const windowServer = createFakeServer({ retval: nativeToScVal(3_600n, { type: 'u64' }) });
    await expect(createEscrow(windowServer).disputeWindow()).resolves.toBe(3_600);
  });

  it('surfaces a failed simulation', async () => {
    const server = createFakeServer({ simulateError: 'HostError: Error(Contract, #3)' });
    await expect(createEscrow(server).getJob(1n)).rejects.toThrowError(/Simulating get_job failed/);
  });

  it('reads a proof, and treats ProofNotFound as "no proof yet"', async () => {
    const proofServer = createFakeServer({
      retval: nativeToScVal({
        job_id: 7n,
        duration_secs: 20n,
        exit_code: 0,
        output_hash: new Uint8Array(32).fill(9),
      }),
    });
    await expect(createEscrow(proofServer).getProof(7n)).resolves.toEqual({
      jobId: 7n,
      durationSecs: 20,
      exitCode: 0,
      outputHash: `0x${'09'.repeat(32)}`,
    });

    const missing = createFakeServer({ simulateError: 'HostError: Error(Contract, #4)' });
    await expect(createEscrow(missing).getProof(7n)).resolves.toBeNull();

    const broken = createFakeServer({ simulateError: 'HostError: Error(Contract, #3)' });
    await expect(createEscrow(broken).getProof(7n)).rejects.toThrowError(/Simulating get_proof/);
  });

  it('reads without a secret key and refuses to write without one', async () => {
    const server = createFakeServer({ retval: nativeToScVal(jobFields({ status: 1 })) });
    const readOnly = createEscrow(server, null);

    expect(readOnly.publicKey).toBeUndefined();
    await expect(readOnly.getJob(7n)).resolves.toMatchObject({ jobId: 7n });
    // Read-only simulation uses an ephemeral source account instead of asking
    // the RPC for a funded one.
    expect(server.getAccount).not.toHaveBeenCalled();
    await expect(
      readOnly.submitProof({
        jobId: 7n,
        durationSecs: 1,
        exitCode: 0,
        outputHash: 'ab'.repeat(32),
      }),
    ).rejects.toThrowError(/secret key is required/);
  });

  it('submits a proof and returns the receipt', async () => {
    const server = createFakeServer();
    const escrow = createEscrow(server);
    await expect(
      escrow.submitProof({ jobId: 7n, durationSecs: 20, exitCode: 0, outputHash: 'ab'.repeat(32) }),
    ).resolves.toEqual({ txHash: 'a'.repeat(64), ledger: 99 });
    expect(server.prepareTransaction).toHaveBeenCalledOnce();
  });

  it('claims a payout and returns the earnings', async () => {
    const server = createFakeServer({ returnValue: nativeToScVal(900n, { type: 'i128' }) });
    const claim = await createEscrow(server).claimPayout(7n);
    expect(claim.earnings).toBe(900n);
    expect(claim.txHash).toBe('a'.repeat(64));
  });

  it('surfaces rejected and unconfirmed transactions', async () => {
    await expect(
      createEscrow(createFakeServer({ sendStatus: 'ERROR' })).claimPayout(1n),
    ).rejects.toThrowError(/rejected the transaction/);
    await expect(
      createEscrow(createFakeServer({ txStatus: rpc.Api.GetTransactionStatus.FAILED })).claimPayout(
        1n,
      ),
    ).rejects.toThrowError(/did not confirm/);
  });

  it('uses the documented contract method names', () => {
    expect(CONTRACT_METHODS).toEqual({
      submitProof: 'submit_proof',
      claimPayout: 'claim_payout',
      getJob: 'get_job',
      getProof: 'get_proof',
      jobCount: 'job_count',
      disputeWindow: 'dispute_window',
    });
  });
});
