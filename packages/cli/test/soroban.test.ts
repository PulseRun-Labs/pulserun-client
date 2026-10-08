import { Account, Keypair, StrKey, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_METHODS,
  DEFAULT_NETWORK,
  NETWORK_PRESETS,
  PulseRunClient,
  PulseRunError,
  type SorobanRpcServer,
  decodeJobRecord,
  decodeJobStatus,
  isTerminalStatus,
  parseSecretKey,
  resolveNetwork,
  stroopsToXlm,
  timeRemainingSeconds,
  toJobId,
  xlmToStroops,
} from '../src/client/soroban.js';

const RUNNER = Keypair.random().publicKey();
const CLIENT_ACCOUNT = Keypair.random().publicKey();
// A real contract ID (StrKey checksum included) so `new Contract()` accepts it.
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));

function jobRecordFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 7n,
    client: CLIENT_ACCOUNT,
    runner: RUNNER,
    image: 'node:22-alpine',
    cmd: 'pnpm test',
    max_budget: 15_000_000n,
    deadline: 2_000_000_000n,
    created_at: 1_999_999_000n,
    status: 2,
    output_hash: new Uint8Array(32).fill(0xab),
    exit_code: 0,
    ...overrides,
  };
}

interface FakeServerOptions {
  retval?: unknown;
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
    simulateTransaction: vi.fn(
      async () =>
        ({
          transactionData: {},
          result: { retval: options.retval ?? nativeToScVal(jobRecordFields()) },
          latestLedger: 1,
        }) as unknown as rpc.Api.SimulateTransactionResponse,
    ),
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

describe('network presets', () => {
  it('defaults to testnet', () => {
    expect(DEFAULT_NETWORK).toBe('testnet');
    expect(resolveNetwork(undefined)).toEqual(NETWORK_PRESETS.testnet);
  });

  it('is case-insensitive', () => {
    expect(resolveNetwork('TESTNET')).toEqual(NETWORK_PRESETS.testnet);
  });

  it('rejects unknown networks with a helpful message', () => {
    expect(() => resolveNetwork('nope')).toThrowError(/Unknown network "nope"/);
  });
});

describe('xlm <-> stroops', () => {
  it('converts whole and fractional amounts exactly', () => {
    expect(xlmToStroops('1')).toBe(10_000_000n);
    expect(xlmToStroops('1.25')).toBe(12_500_000n);
    expect(xlmToStroops(5)).toBe(50_000_000n);
    expect(xlmToStroops('0.0000001')).toBe(1n);
  });

  it('rejects malformed amounts', () => {
    for (const value of ['', 'abc', '-1', '1.12345678', '1e3']) {
      expect(() => xlmToStroops(value)).toThrowError(PulseRunError);
    }
  });

  it('round-trips back into a minimal decimal string', () => {
    expect(stroopsToXlm(12_500_000n)).toBe('1.25');
    expect(stroopsToXlm(10_000_000n)).toBe('1');
    expect(stroopsToXlm(1n)).toBe('0.0000001');
    expect(stroopsToXlm(-10_000_001n)).toBe('-1.0000001');
  });
});

describe('job ids and statuses', () => {
  it('normalises job ids', () => {
    expect(toJobId(42)).toBe(42n);
    expect(toJobId('42')).toBe(42n);
    expect(toJobId('#42')).toBe(42n);
    expect(toJobId(42n)).toBe(42n);
  });

  it('rejects malformed job ids', () => {
    expect(() => toJobId('abc')).toThrowError(/Invalid job id/);
    expect(() => toJobId(-1)).toThrowError(/Invalid job id/);
  });

  it('decodes numeric and symbol statuses', () => {
    expect(decodeJobStatus(0)).toBe('Pending');
    expect(decodeJobStatus(2)).toBe('Completed');
    expect(decodeJobStatus('failed')).toBe('Failed');
    expect(() => decodeJobStatus(99)).toThrowError(/Unknown job status/);
    expect(() => decodeJobStatus({})).toThrowError(/usable job status/);
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminalStatus('Completed')).toBe(true);
    expect(isTerminalStatus('Expired')).toBe(true);
    expect(isTerminalStatus('Running')).toBe(false);
    expect(timeRemainingSeconds(100, 40)).toBe(60);
  });
});

describe('decodeJobRecord', () => {
  it('maps snake_case contract fields', () => {
    const job = decodeJobRecord(jobRecordFields());
    expect(job.id).toBe(7n);
    expect(job.image).toBe('node:22-alpine');
    expect(job.command).toBe('pnpm test');
    expect(job.maxBudgetStroops).toBe(15_000_000n);
    expect(job.status).toBe('Completed');
    expect(job.exitCode).toBe(0);
    expect(job.outputHash).toMatch(/^0x(ab){32}$/);
  });

  it('accepts camelCase aliases and null proofs', () => {
    const job = decodeJobRecord({
      jobId: '9',
      client: CLIENT_ACCOUNT,
      runner: RUNNER,
      image: 'alpine',
      command: 'echo hi',
      maxBudget: 1n,
      deadline: 10,
      createdAt: 5,
      status: 'Pending',
      outputHash: null,
      exitCode: null,
    });
    expect(job.id).toBe(9n);
    expect(job.command).toBe('echo hi');
    expect(job.outputHash).toBeNull();
    expect(job.exitCode).toBeNull();
  });

  it('rejects non-object payloads', () => {
    expect(() => decodeJobRecord('nope')).toThrowError(/unexpected value/);
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
    const keypair = Keypair.random();
    const client = createClient(server, keypair);

    const submission = await client.createJob({
      image: 'node:22-alpine',
      command: 'pnpm test',
      maxBudgetXlm: '1.5',
      runner: RUNNER,
      timeoutSeconds: 600,
      now: 1_000,
    });

    expect(submission).toEqual({ jobId: 7n, txHash: 'a'.repeat(64), ledger: 42 });
    expect(server.prepareTransaction).toHaveBeenCalledOnce();
    expect(server.sendTransaction).toHaveBeenCalledOnce();
  });

  it('fails create_job without a signer', async () => {
    const client = new PulseRunClient({
      rpcUrl: 'https://example.test',
      networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
      contractId: CONTRACT_ID,
      server: createFakeServer(),
    });
    await expect(
      client.createJob({ image: 'alpine', command: 'ls', maxBudgetXlm: '1' }),
    ).rejects.toThrowError(/secret key is required/);
  });

  it('rejects a non-positive budget before touching the network', async () => {
    const server = createFakeServer();
    const client = createClient(server);
    await expect(
      client.createJob({ image: 'alpine', command: 'ls', maxBudgetXlm: '0' }),
    ).rejects.toThrowError(/greater than zero/);
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it('surfaces a rejected transaction', async () => {
    const server = createFakeServer({ sendStatus: 'ERROR' });
    const client = createClient(server);
    await expect(
      client.createJob({ image: 'alpine', command: 'ls', maxBudgetXlm: '1' }),
    ).rejects.toThrowError(/rejected the create_job transaction/);
  });

  it('reads a job through a read-only simulation without a key', async () => {
    const server = createFakeServer({ retval: nativeToScVal(jobRecordFields()) });
    const client = new PulseRunClient({
      rpcUrl: 'https://example.test',
      networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
      contractId: CONTRACT_ID,
      server,
    });

    const job = await client.getJob(7);
    expect(job.status).toBe('Completed');
    expect(server.simulateTransaction).toHaveBeenCalledOnce();
    // No signer configured, so the read must use an ephemeral source account.
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it('reports a failed simulation', async () => {
    const server = createFakeServer();
    server.simulateTransaction = vi.fn(async () => ({ error: 'boom' }) as never);
    const client = new PulseRunClient({
      rpcUrl: 'https://example.test',
      networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
      contractId: CONTRACT_ID,
      server,
    });
    await expect(client.getJob(1)).rejects.toThrowError(/Simulating get_job failed: boom/);
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
        result: { retval: nativeToScVal(jobRecordFields({ status })) },
        latestLedger: 1,
      } as unknown as rpc.Api.SimulateTransactionResponse;
    });

    const client = new PulseRunClient({
      rpcUrl: 'https://example.test',
      networkPassphrase: NETWORK_PRESETS.testnet.networkPassphrase,
      contractId: CONTRACT_ID,
      server,
      pollIntervalMs: 1,
    });

    const observed: string[] = [];
    const job = await client.waitForJob(7, {
      timeoutMs: 1_000,
      onPoll: (polled) => observed.push(polled.status),
    });

    expect(observed).toEqual(['Pending', 'Running', 'Failed']);
    expect(job.status).toBe('Failed');
  });

  it('uses the documented contract method names', () => {
    expect(CONTRACT_METHODS).toEqual({
      createJob: 'create_job',
      getJob: 'get_job',
      submitProof: 'submit_proof',
    });
  });
});

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
