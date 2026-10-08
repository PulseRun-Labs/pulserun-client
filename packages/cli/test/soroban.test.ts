import {
  Account,
  Address,
  Keypair,
  StrKey,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_METHODS,
  DEFAULT_NETWORK,
  NETWORK_PRESETS,
  PulseRunClient,
  PulseRunError,
  type SorobanRpcServer,
  decodeComputeJob,
  decodeExecutionProof,
  decodeJobStatus,
  describeContractError,
  encodeExecutionProof,
  errorName,
  extractErrorCode,
  formatTokenAmount,
  isTerminalStatus,
  parseSecretKey,
  parseTokenAmount,
  resolveNetwork,
  toJobId,
  toOutputHashBytes,
} from '../src/client/soroban.js';

const RUNNER = Keypair.random().publicKey();
const REQUESTER = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 2));
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const ZERO_HASH = `0x${'00'.repeat(32)}`;

function jobFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 7n,
    requester: REQUESTER,
    runner: RUNNER,
    payment_token: TOKEN,
    max_budget: 15_000_000n,
    rate_per_second: 1_000n,
    max_duration_secs: 600n,
    status: 1,
    created_at: 1_999_999_000n,
    completed_at: 1_999_999_500n,
    output_hash: new Uint8Array(32).fill(0xab),
    ...overrides,
  };
}

interface FakeServerOptions {
  retval?: unknown;
  simulateError?: string;
  txStatus?: string;
  sendStatus?: string;
  returnValue?: unknown;
}

function createFakeServer(options: FakeServerOptions = {}) {
  const hash = 'a'.repeat(64);
  const server: SorobanRpcServer = {
    getAccount: vi.fn(async (address: string) => new Account(address, '100')),
    prepareTransaction: vi.fn(async (tx) => tx),
    sendTransaction: vi.fn(
      async () => ({ status: options.sendStatus ?? 'PENDING', hash }) as never,
    ),
    pollTransaction: vi.fn(
      async () =>
        ({
          status: options.txStatus ?? rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 42,
          returnValue: options.returnValue ?? nativeToScVal(options.retval ?? 7n, { type: 'u64' }),
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
  return server;
}

function createClient(server: SorobanRpcServer, keypair = Keypair.random()) {
  return new PulseRunClient({
    rpcUrl: 'https://example.test',
    networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
    contractId: CONTRACT_ID,
    keypair,
    server,
    pollIntervalMs: 1,
  });
}

const CREATE_PARAMS = {
  runner: RUNNER,
  paymentToken: TOKEN,
  maxBudget: 15_000_000n,
  ratePerSecond: 1_000n,
  maxDurationSecs: 600,
};

describe('network presets', () => {
  it('defaults to testnet and is case-insensitive', () => {
    expect(DEFAULT_NETWORK).toBe('testnet');
    expect(resolveNetwork(undefined)).toEqual(NETWORK_PRESETS.testnet);
    expect(resolveNetwork('TESTNET')).toEqual(NETWORK_PRESETS.testnet);
  });

  it('rejects unknown networks', () => {
    expect(() => resolveNetwork('nope')).toThrowError(/Unknown network "nope"/);
  });
});

describe('token base-unit maths', () => {
  it('converts decimals exactly', () => {
    expect(parseTokenAmount('1', 7)).toBe(10_000_000n);
    expect(parseTokenAmount('1.25', 7)).toBe(12_500_000n);
    expect(parseTokenAmount('0.0000001', 7)).toBe(1n);
    expect(parseTokenAmount('5', 0)).toBe(5n);
  });

  it('rejects malformed amounts', () => {
    for (const value of ['', 'abc', '-1', '1.12345678', '1e3']) {
      expect(() => parseTokenAmount(value, 7)).toThrowError(PulseRunError);
    }
  });

  it('round-trips back into a minimal decimal string', () => {
    expect(formatTokenAmount(12_500_000n, 7)).toBe('1.25');
    expect(formatTokenAmount(10_000_000n, 7)).toBe('1');
    expect(formatTokenAmount(1n, 7)).toBe('0.0000001');
    expect(formatTokenAmount(-10_000_001n, 7)).toBe('-1.0000001');
  });
});

describe('job ids, statuses and error codes', () => {
  it('normalises job ids', () => {
    expect(toJobId(42)).toBe(42n);
    expect(toJobId('42')).toBe(42n);
    expect(toJobId('#42')).toBe(42n);
    expect(() => toJobId('abc')).toThrowError(/Invalid job id/);
    expect(() => toJobId(-1)).toThrowError(/Invalid job id/);
  });

  it('decodes numeric and symbol statuses', () => {
    expect(decodeJobStatus(0)).toBe('Queued');
    expect(decodeJobStatus(1)).toBe('Completed');
    expect(decodeJobStatus(2)).toBe('Disputed');
    expect(decodeJobStatus('settled')).toBe('Settled');
    expect(() => decodeJobStatus(99)).toThrowError(/Unknown job status/);
    expect(() => decodeJobStatus({})).toThrowError(/usable job status/);
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminalStatus('Settled')).toBe(true);
    expect(isTerminalStatus('Refunded')).toBe(true);
    expect(isTerminalStatus('Disputed')).toBe(false);
    expect(isTerminalStatus('Queued')).toBe(false);
  });

  it('maps contract error codes to ABI names', () => {
    expect(errorName(4)).toBe('ProofNotFound');
    expect(errorName(14)).toBe('MathOverflow');
    expect(errorName(99)).toBeUndefined();
    expect(extractErrorCode('HostError: Error(Contract, #5)')).toBe(5);
    expect(extractErrorCode('plain failure')).toBeNull();
    expect(describeContractError('HostError: Error(Contract, #11)')).toBe(
      'DisputeWindowActive (contract error #11)',
    );
  });
});

describe('decoding', () => {
  it('maps ComputeJob fields', () => {
    const job = decodeComputeJob(jobFields());
    expect(job.jobId).toBe(7n);
    expect(job.requester).toBe(REQUESTER);
    expect(job.paymentToken).toBe(TOKEN);
    expect(job.maxBudget).toBe(15_000_000n);
    expect(job.ratePerSecond).toBe(1_000n);
    expect(job.maxDurationSecs).toBe(600);
    expect(job.status).toBe('Completed');
    expect(job.completedAt).toBe(1_999_999_500);
    expect(job.outputHash).toMatch(/^0x(ab){32}$/);
  });

  it('accepts camelCase aliases', () => {
    const job = decodeComputeJob({
      jobId: '9',
      requester: REQUESTER,
      runner: RUNNER,
      paymentToken: TOKEN,
      maxBudget: 1n,
      ratePerSecond: 1n,
      maxDurationSecs: 10,
      status: 'Queued',
      createdAt: 5,
      completedAt: 0,
      outputHash: new Uint8Array(32),
    });
    expect(job.jobId).toBe(9n);
    expect(job.outputHash).toBe(ZERO_HASH);
  });

  it('decodes an ExecutionProof', () => {
    const proof = decodeExecutionProof({
      job_id: 7n,
      duration_secs: 20n,
      exit_code: 0n,
      output_hash: new Uint8Array(32).fill(1),
    });
    expect(proof).toEqual({
      jobId: 7n,
      durationSecs: 20,
      exitCode: 0,
      outputHash: `0x${'01'.repeat(32)}`,
    });
  });

  it('rejects non-object payloads', () => {
    expect(() => decodeComputeJob('nope')).toThrowError(/unexpected value/);
  });
});

describe('argument encoding', () => {
  it('encodes an ExecutionProof as a symbol-keyed map', () => {
    const scval = encodeExecutionProof({
      jobId: 7n,
      durationSecs: 20,
      exitCode: 0,
      outputHash: 'ab'.repeat(32),
    });
    const native = scValToNative(scval) as Record<string, unknown>;
    expect(Object.keys(native).sort()).toEqual([
      'duration_secs',
      'exit_code',
      'job_id',
      'output_hash',
    ]);
    expect(native['duration_secs']).toBe(20n);
    expect(native['output_hash']).toHaveLength(32);
  });

  it('rejects out-of-range exit codes and durations', () => {
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
  });

  it('normalises output hashes to exactly 32 bytes', () => {
    expect(toOutputHashBytes('ab'.repeat(32))).toHaveLength(32);
    expect(toOutputHashBytes(`0x${'ab'.repeat(32)}`)).toHaveLength(32);
    expect(() => toOutputHashBytes('deadbeef')).toThrowError(/32 bytes/);
  });
});

describe('PulseRunClient', () => {
  it('requires a contract id', () => {
    expect(
      () =>
        new PulseRunClient({
          rpcUrl: 'https://example.test',
          networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
          contractId: '',
        }),
    ).toThrowError(/contract ID is required/);
  });

  it('submits create_job and returns the on-chain id', async () => {
    const server = createFakeServer({ retval: 7n });
    const client = createClient(server);

    const submission = await client.createJob(CREATE_PARAMS);

    expect(submission).toEqual({ jobId: 7n, txHash: 'a'.repeat(64), ledger: 42 });
    expect(server.prepareTransaction).toHaveBeenCalledOnce();
    expect(server.sendTransaction).toHaveBeenCalledOnce();
  });

  it('validates amounts before touching the network', async () => {
    const server = createFakeServer();
    const client = createClient(server);
    await expect(client.createJob({ ...CREATE_PARAMS, maxBudget: 0n })).rejects.toThrowError(
      /greater than zero/,
    );
    await expect(client.createJob({ ...CREATE_PARAMS, ratePerSecond: 0n })).rejects.toThrowError(
      /rate per second/i,
    );
    await expect(client.createJob({ ...CREATE_PARAMS, maxDurationSecs: 0 })).rejects.toThrowError(
      /max duration/,
    );
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it('fails without a signer', async () => {
    const client = new PulseRunClient({
      rpcUrl: 'https://example.test',
      networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
      contractId: CONTRACT_ID,
      server: createFakeServer(),
    });
    await expect(client.createJob(CREATE_PARAMS)).rejects.toThrowError(/secret key is required/);
  });

  it('surfaces a rejected transaction', async () => {
    const client = createClient(createFakeServer({ sendStatus: 'ERROR' }));
    await expect(client.createJob(CREATE_PARAMS)).rejects.toThrowError(/rejected the transaction/);
  });

  it('reads jobs through a simulation without a key', async () => {
    const server = createFakeServer({ retval: nativeToScVal(jobFields()) });
    const client = new PulseRunClient({
      rpcUrl: 'https://example.test',
      networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
      contractId: CONTRACT_ID,
      server,
    });

    const job = await client.getJob(7);
    expect(job.status).toBe('Completed');
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it('returns null from getProof when the contract reports ProofNotFound', async () => {
    const server = createFakeServer({ simulateError: 'HostError: Error(Contract, #4)' });
    const client = createPulseClient(server);
    await expect(client.getProof(7)).resolves.toBeNull();
  });

  it('reports a failed simulation for other errors', async () => {
    const server = createFakeServer({ simulateError: 'HostError: Error(Contract, #3)' });
    const client = createPulseClient(server);
    await expect(client.getJob(1)).rejects.toThrowError(/Simulating get_job failed/);
  });

  it('reads the job count', async () => {
    const client = createPulseClient(
      createFakeServer({ retval: nativeToScVal(5n, { type: 'u64' }) }),
    );
    await expect(client.getJobCount()).resolves.toBe(5n);
  });

  it('claims a payout and returns the earnings', async () => {
    const client = createClient(
      createFakeServer({ returnValue: nativeToScVal(900n, { type: 'i128' }) }),
    );
    const claim = await client.claimPayout(7);
    expect(claim.earnings).toBe(900n);
    expect(claim.txHash).toBe('a'.repeat(64));
  });

  it('submits a proof as the runner', async () => {
    const client = createClient(createFakeServer());
    await expect(
      client.submitProof({ jobId: 7n, durationSecs: 20, exitCode: 0, outputHash: 'ab'.repeat(32) }),
    ).resolves.toEqual({ txHash: 'a'.repeat(64), ledger: 42 });
  });

  it('disputes and cancels as the requester', async () => {
    const client = createClient(createFakeServer());
    await expect(client.disputeJob(7)).resolves.toEqual({ txHash: 'a'.repeat(64), ledger: 42 });
    await expect(client.cancelUnclaimedJob(7)).resolves.toEqual({
      txHash: 'a'.repeat(64),
      ledger: 42,
    });
  });

  it('polls until the job reaches a terminal state', async () => {
    const statuses = [0, 1, 3];
    let call = 0;
    const server = createFakeServer();
    server.simulateTransaction = vi.fn(async () => {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call += 1;
      return {
        transactionData: {},
        result: { retval: nativeToScVal(jobFields({ status })) },
        latestLedger: 1,
      } as unknown as rpc.Api.SimulateTransactionResponse;
    });

    const client = createPulseClient(server);
    const observed: string[] = [];
    const job = await client.waitForJob(7, {
      timeoutMs: 1_000,
      onPoll: (polled) => observed.push(polled.status),
    });

    expect(observed).toEqual(['Queued', 'Completed', 'Settled']);
    expect(job.status).toBe('Settled');
  });

  it('uses the documented contract method names', () => {
    expect(CONTRACT_METHODS).toMatchObject({
      createJob: 'create_job',
      submitProof: 'submit_proof',
      claimPayout: 'claim_payout',
      disputeJob: 'dispute_job',
      cancelUnclaimedJob: 'cancel_unclaimed_job',
      getJob: 'get_job',
      getProof: 'get_proof',
      jobCount: 'job_count',
      disputeWindow: 'dispute_window',
      admin: 'admin',
    });
  });
});

function createPulseClient(server: SorobanRpcServer) {
  return new PulseRunClient({
    rpcUrl: 'https://example.test',
    networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
    contractId: CONTRACT_ID,
    server,
    pollIntervalMs: 1,
  });
}

describe('parseSecretKey', () => {
  it('accepts a valid seed', () => {
    const keypair = Keypair.random();
    expect(parseSecretKey(keypair.secret()).publicKey()).toBe(keypair.publicKey());
  });

  it('explains invalid seeds', () => {
    expect(() => parseSecretKey('not-a-key')).toThrowError(
      /Could not parse the Stellar secret key/,
    );
  });
});

describe('admin view', () => {
  it('decodes an address', async () => {
    const client = createPulseClient(
      createFakeServer({ retval: new Address(REQUESTER).toScVal() }),
    );
    await expect(client.getAdmin()).resolves.toBe(REQUESTER);
  });
});
