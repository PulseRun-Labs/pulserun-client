/**
 * Soroban client for the PulseRun escrow contract.
 *
 * The CLI never talks to the runner directly: it locks a budget in the escrow
 * contract and then observes the on-chain job state while a runner daemon
 * executes the workload and submits an execution proof.
 *
 * ## Expected contract interface
 *
 * ```text
 * create_job(from: Address, runner: Address, image: String, cmd: String,
 *            max_budget: i128, deadline: u64) -> u64
 * get_job(job_id: u64) -> Job
 * submit_proof(runner: Address, job_id: u64, output_hash: BytesN<32>,
 *              exit_code: i32, success: bool) -> ()
 *
 * Job {
 *   job_id: u64,
 *   client: Address,
 *   runner: Address,
 *   image: String,
 *   cmd: String,
 *   max_budget: i128,   // stroops
 *   deadline: u64,      // unix seconds
 *   created_at: u64,    // unix seconds
 *   status: u32,        // see JOB_STATUSES
 *   output_hash: Option<BytesN<32>>,
 *   exit_code: Option<i32>,
 * }
 * ```
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';
import type { Transaction, xdr } from '@stellar/stellar-sdk';

/** Number of stroops in one XLM. */
export const STROOPS_PER_XLM = 10_000_000n;

/** Default job deadline, in seconds, when the caller does not supply one. */
export const DEFAULT_JOB_TIMEOUT_SECONDS = 3600;

/** Default delay between job status polls. */
export const DEFAULT_POLL_INTERVAL_MS = 4_000;

/** Contract method names, kept together so the ABI stays discoverable. */
export const CONTRACT_METHODS = {
  createJob: 'create_job',
  getJob: 'get_job',
  submitProof: 'submit_proof',
} as const;

/** Any error raised by the PulseRun client. */
export class PulseRunError extends Error {
  override readonly name = 'PulseRunError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export type NetworkName = 'testnet' | 'futurenet' | 'mainnet' | 'local';

export interface NetworkPreset {
  rpcUrl: string;
  networkPassphrase: string;
}

export const NETWORK_PRESETS: Record<NetworkName, NetworkPreset> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: Networks.FUTURENET,
  },
  mainnet: {
    rpcUrl: 'https://soroban-mainnet.stellar.org',
    networkPassphrase: Networks.PUBLIC,
  },
  local: {
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: Networks.STANDALONE,
  },
};

export const DEFAULT_NETWORK: NetworkName = 'testnet';

/** Resolves a `--network` value into an RPC URL and network passphrase. */
export function resolveNetwork(name: string | undefined): NetworkPreset {
  const key = (name ?? DEFAULT_NETWORK).trim().toLowerCase();
  if (key in NETWORK_PRESETS) {
    return NETWORK_PRESETS[key as NetworkName];
  }
  throw new PulseRunError(
    `Unknown network "${name}". Expected one of: ${Object.keys(NETWORK_PRESETS).join(', ')}.`,
  );
}

// ---------------------------------------------------------------------------
// Job model
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  'Pending',
  'Running',
  'Completed',
  'Failed',
  'Expired',
  'Cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

const TERMINAL_STATUSES: readonly JobStatus[] = ['Completed', 'Failed', 'Expired', 'Cancelled'];

/** True once a job can no longer change state on-chain. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Maps the contract's `status` field (a `u32` discriminant, although we also
 * accept the symbol form for forward compatibility) to a `JobStatus`.
 */
export function decodeJobStatus(value: unknown): JobStatus {
  if (typeof value === 'string') {
    const match = JOB_STATUSES.find((status) => status.toLowerCase() === value.toLowerCase());
    if (match) return match;
    throw new PulseRunError(`Unknown job status "${value}" returned by the contract.`);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const index = Number(value);
    const status = JOB_STATUSES[index];
    if (status) return status;
    throw new PulseRunError(`Unknown job status discriminant ${String(value)}.`);
  }
  throw new PulseRunError('The contract did not return a usable job status.');
}

export interface JobRecord {
  /** On-chain job identifier. */
  id: bigint;
  /** Address that funded the escrow. */
  client: string;
  /** Address allowed to execute the job. */
  runner: string;
  /** Docker image the runner must execute. */
  image: string;
  /** Shell command executed inside the container. */
  command: string;
  /** Escrowed budget in stroops. */
  maxBudgetStroops: bigint;
  /** Unix timestamp (seconds) after which the job expires. */
  deadline: number;
  /** Unix timestamp (seconds) at which the job was created. */
  createdAt: number;
  status: JobStatus;
  /** SHA-256 proof submitted by the runner, hex encoded, when available. */
  outputHash: string | null;
  exitCode: number | null;
}

/** Seconds until `deadline`, negative once the deadline has passed. */
export function timeRemainingSeconds(deadline: number, nowSeconds: number): number {
  return deadline - nowSeconds;
}

/** JSON-friendly projection of a {@link JobRecord}, used by `--json` output. */
export interface JobJson {
  jobId: string;
  client: string;
  runner: string;
  image: string;
  command: string;
  maxBudgetXlm: string;
  maxBudgetStroops: string;
  deadline: number;
  createdAt: number;
  status: JobStatus;
  outputHash: string | null;
  exitCode: number | null;
  timeRemainingSeconds: number;
}

export function jobToJson(job: JobRecord, nowSeconds: number): JobJson {
  return {
    jobId: job.id.toString(),
    client: job.client,
    runner: job.runner,
    image: job.image,
    command: job.command,
    maxBudgetXlm: stroopsToXlm(job.maxBudgetStroops),
    maxBudgetStroops: job.maxBudgetStroops.toString(),
    deadline: job.deadline,
    createdAt: job.createdAt,
    status: job.status,
    outputHash: job.outputHash,
    exitCode: job.exitCode,
    timeRemainingSeconds: timeRemainingSeconds(job.deadline, nowSeconds),
  };
}

// ---------------------------------------------------------------------------
// XLM <-> stroops helpers
// ---------------------------------------------------------------------------

const DECIMAL_AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * Converts a decimal XLM amount into stroops without going through a float.
 *
 * @throws {PulseRunError} when the amount is not a positive decimal with at
 *   most 7 decimal places.
 */
export function xlmToStroops(amount: string | number): bigint {
  const text = (typeof amount === 'number' ? String(amount) : amount).trim();
  if (!DECIMAL_AMOUNT_RE.test(text)) {
    throw new PulseRunError(
      `Invalid XLM amount "${text}": expected a positive decimal such as "5" or "1.25".`,
    );
  }

  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > 7) {
    throw new PulseRunError(
      `Invalid XLM amount "${text}": at most 7 decimal places (1 stroop) are supported.`,
    );
  }

  return BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, '0'));
}

/** Converts stroops back into a minimal decimal XLM string. */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM).toString().padStart(7, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// ---------------------------------------------------------------------------
// Native decoding helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PulseRunError(`Contract returned an unexpected value for "${field}".`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new PulseRunError(`Contract returned a non-string "${field}".`);
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new PulseRunError(`Contract returned a non-integer "${field}".`);
}

function asOptionalBytesHex(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'string') {
    if (value.length === 0 || value === '0x') return null;
    return value.startsWith('0x') ? value : `0x${value}`;
  }
  throw new PulseRunError(`Contract returned an unexpected "${field}".`);
}

function asOptionalInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new PulseRunError(`Contract returned an unexpected "${field}".`);
}

/**
 * Converts the native value returned by `get_job` into a {@link JobRecord}.
 *
 * Exported because both `pulserun status` and the polling loop in
 * `pulserun run` need identical decoding.
 */
export function decodeJobRecord(value: unknown): JobRecord {
  const raw = asRecord(value, 'Job');
  const outputHash = asOptionalBytesHex(raw['output_hash'] ?? raw['outputHash'], 'output_hash');

  return {
    id: asBigInt(raw['job_id'] ?? raw['jobId'] ?? raw['id'], 'job_id'),
    client: asString(raw['client'], 'client'),
    runner: asString(raw['runner'], 'runner'),
    image: asString(raw['image'], 'image'),
    command: asString(raw['cmd'] ?? raw['command'], 'cmd'),
    maxBudgetStroops: asBigInt(raw['max_budget'] ?? raw['maxBudget'], 'max_budget'),
    deadline: Number(asBigInt(raw['deadline'], 'deadline')),
    createdAt: Number(asBigInt(raw['created_at'] ?? raw['createdAt'], 'created_at')),
    status: decodeJobStatus(raw['status']),
    outputHash,
    exitCode: asOptionalInt(raw['exit_code'] ?? raw['exitCode'], 'exit_code'),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * The subset of `rpc.Server` the CLI depends on. Narrowing it here keeps the
 * client unit-testable with a lightweight fake.
 */
export interface SorobanRpcServer {
  getAccount(address: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(
    hash: string,
    options?: { attempts?: number },
  ): Promise<rpc.Api.GetTransactionResponse>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

export interface PulseRunClientOptions {
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Stellar network passphrase matching `rpcUrl`. */
  networkPassphrase: string;
  /** Escrow contract ID (`C...`). */
  contractId: string;
  /** Signer used for state-changing calls. */
  keypair?: Keypair;
  /** Optional RPC override, primarily for tests. */
  server?: SorobanRpcServer;
  /** Transaction fee in stroops; defaults to `BASE_FEE`. */
  fee?: string;
  /** Delay between polls in {@link PulseRunClient.waitForJob}. */
  pollIntervalMs?: number;
}

export interface CreateJobParams {
  /** Docker image the runner must execute. */
  image: string;
  /** Shell command executed inside the container. */
  command: string;
  /** Escrowed budget in XLM (decimal string). */
  maxBudgetXlm: string | number;
  /** Address allowed to execute the job; defaults to the signer. */
  runner?: string;
  /** Address funding the escrow; defaults to the signer. */
  client?: string;
  /** Deadline, in seconds from now. */
  timeoutSeconds?: number;
  /** Overrides the current unix time, in seconds; used by tests. */
  now?: number;
}

export interface JobSubmission {
  jobId: bigint;
  txHash: string;
  ledger: number;
}

export interface WaitForJobOptions {
  /** Overall polling budget in milliseconds. */
  timeoutMs?: number;
  /** Called after every successful poll. */
  onPoll?: (job: JobRecord) => void;
}

export class PulseRunClient {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
  readonly contractId: string;
  readonly keypair: Keypair | undefined;
  readonly pollIntervalMs: number;

  private readonly server: SorobanRpcServer;
  private readonly fee: string;

  constructor(options: PulseRunClientOptions) {
    if (!options.contractId) {
      throw new PulseRunError(
        'A PulseRun escrow contract ID is required. Pass --contract or set PULSERUN_CONTRACT_ID.',
      );
    }

    this.rpcUrl = options.rpcUrl;
    this.networkPassphrase = options.networkPassphrase;
    this.contractId = options.contractId;
    this.keypair = options.keypair;
    this.fee = options.fee ?? BASE_FEE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.server =
      options.server ??
      new rpc.Server(options.rpcUrl, { allowHttp: options.rpcUrl.startsWith('http://') });
  }

  /** Builds a client from a Stellar secret key. */
  static fromSecretKey(secret: string, options: Omit<PulseRunClientOptions, 'keypair'>) {
    return new PulseRunClient({ ...options, keypair: parseSecretKey(secret) });
  }

  /** The public key that will sign transactions and own the escrow. */
  get publicKey(): string | undefined {
    return this.keypair?.publicKey();
  }

  /**
   * Invokes `create_job`, locking `maxBudget` XLM in escrow, and waits for the
   * transaction to be included in a ledger.
   */
  async createJob(params: CreateJobParams): Promise<JobSubmission> {
    const signer = this.requireSigner();
    const maxBudget = xlmToStroops(params.maxBudgetXlm);
    if (maxBudget <= 0n) {
      throw new PulseRunError('The max budget must be greater than zero XLM.');
    }

    const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new PulseRunError(`Invalid timeout "${String(timeoutSeconds)}": expected seconds > 0.`);
    }

    const now = params.now ?? Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + Math.floor(timeoutSeconds));
    const clientAddress = new Address(params.client ?? signer.publicKey());
    const runnerAddress = new Address(params.runner ?? signer.publicKey());

    const account = await this.server.getAccount(signer.publicKey());
    const contract = new Contract(this.contractId);
    const operation = contract.call(
      CONTRACT_METHODS.createJob,
      clientAddress.toScVal(),
      runnerAddress.toScVal(),
      nativeToScVal(params.image, { type: 'string' }),
      nativeToScVal(params.command, { type: 'string' }),
      nativeToScVal(maxBudget, { type: 'i128' }),
      nativeToScVal(deadline, { type: 'u64' }),
    );

    const transaction = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(signer);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new PulseRunError(`The network rejected the create_job transaction (${sent.hash}).`);
    }

    const confirmation = await this.server.pollTransaction(sent.hash, { attempts: 10 });
    if (confirmation.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new PulseRunError(
        `create_job did not confirm (status: ${confirmation.status}, tx: ${sent.hash}).`,
      );
    }

    const returnValue = confirmation.returnValue;
    if (!returnValue) {
      throw new PulseRunError(
        `create_job confirmed but returned no job id (tx: ${sent.hash}). Check that the contract ID is correct.`,
      );
    }

    return {
      jobId: asBigInt(scValToNative(returnValue), 'job_id'),
      txHash: sent.hash,
      ledger: confirmation.ledger,
    };
  }

  /** Reads a job's current on-chain state via a read-only simulation. */
  async getJob(jobId: bigint | number | string): Promise<JobRecord> {
    const retval = await this.simulateRead(
      CONTRACT_METHODS.getJob,
      nativeToScVal(toJobId(jobId), { type: 'u64' }),
    );
    return decodeJobRecord(scValToNative(retval));
  }

  /**
   * Polls `get_job` until the job reaches a terminal state or `timeoutMs`
   * elapses. The last observed record is always returned, so callers can
   * distinguish "still running" from "finished" with {@link isTerminalStatus}.
   */
  async waitForJob(jobId: bigint | number | string, options: WaitForJobOptions = {}): Promise<JobRecord> {
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const job = await this.getJob(jobId);
      options.onPoll?.(job);
      if (isTerminalStatus(job.status)) return job;
      if (Date.now() >= deadline) return job;
      await sleep(this.pollIntervalMs);
    }
  }

  private requireSigner(): Keypair {
    if (!this.keypair) {
      throw new PulseRunError(
        'A Stellar secret key is required to sign this transaction. Pass --key or set PULSERUN_SECRET_KEY.',
      );
    }
    return this.keypair;
  }

  /**
   * Builds a transaction for a read-only contract call and simulates it.
   * When no signer is configured we use an ephemeral source account so that
   * `pulserun status` works without holding a key.
   */
  private async simulateRead(
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<xdr.ScVal> {
    const account = await this.resolveSourceAccount();
    const contract = new Contract(this.contractId);
    const transaction = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new PulseRunError(`Simulating ${method} failed: ${simulation.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new PulseRunError(
        `Simulating ${method} returned no value. Check that ${this.contractId} implements ${method}.`,
      );
    }
    return simulation.result.retval;
  }

  private async resolveSourceAccount(): Promise<Account> {
    if (this.keypair) {
      return this.server.getAccount(this.keypair.publicKey());
    }
    // Read-only simulation does not need a funded account; a brand new key
    // pair keeps us from forcing users to hold a key just to read state.
    return new Account(Keypair.random().publicKey(), '0');
  }
}

/** Validates and parses a Stellar secret key, with a friendly error message. */
export function parseSecretKey(secret: string): Keypair {
  try {
    return Keypair.fromSecret(secret.trim());
  } catch (error) {
    throw new PulseRunError(
      'Could not parse the Stellar secret key: expected an S... seed for the selected network.',
      { cause: error },
    );
  }
}

/** Normalises a user-supplied job id into a `u64`-safe bigint. */
export function toJobId(jobId: bigint | number | string): bigint {
  if (typeof jobId === 'bigint') return jobId;
  if (typeof jobId === 'number') {
    if (!Number.isInteger(jobId) || jobId < 0) {
      throw new PulseRunError(`Invalid job id "${String(jobId)}": expected a non-negative integer.`);
    }
    return BigInt(jobId);
  }
  const text = jobId.trim().replace(/^#/, '');
  if (!/^\d+$/.test(text)) {
    throw new PulseRunError(`Invalid job id "${jobId}": expected a non-negative integer.`);
  }
  return BigInt(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the event loop alive just for a poll interval.
    timer.unref?.();
  });
}
