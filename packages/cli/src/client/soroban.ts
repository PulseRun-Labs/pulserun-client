/**
 * Soroban client for the PulseRun escrow contract (`PulseEscrow`).
 *
 * The CLI never talks to the runner directly: it opens an escrow on-chain and
 * then observes the job while a runner daemon executes the workload and submits
 * an execution proof. Settlement pays the runner for the seconds actually
 * executed and returns the unspent remainder to the requester.
 *
 * ## Contract interface (pulserun-core)
 *
 * ```text
 * init(admin: Address, dispute_window_secs: u64) -> ()
 * create_job(requester: Address, runner: Address, payment_token: Address,
 *            max_budget: i128, rate_per_second: i128,
 *            max_duration_secs: u64) -> u64
 * submit_proof(runner: Address, proof: ExecutionProof) -> ()
 * claim_payout(job_id: u64) -> i128
 * dispute_job(requester: Address, job_id: u64) -> ()
 * cancel_unclaimed_job(requester: Address, job_id: u64) -> ()
 * get_job(job_id: u64) -> ComputeJob
 * get_proof(job_id: u64) -> ExecutionProof
 * job_count() -> u64
 * dispute_window() -> u64
 * admin() -> Address
 *
 * ComputeJob {
 *   job_id: u64, requester: Address, runner: Address, payment_token: Address,
 *   max_budget: i128, rate_per_second: i128, max_duration_secs: u64,
 *   status: JobStatus, created_at: u64, completed_at: u64, output_hash: BytesN<32>,
 * }
 * ExecutionProof { job_id: u64, duration_secs: u64, exit_code: i32, output_hash: BytesN<32> }
 * ```
 *
 * Amounts are in the `payment_token`'s base units; time is in ledger seconds.
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
  xdr,
} from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';

/** Default delay between job status polls. */
export const DEFAULT_POLL_INTERVAL_MS = 4_000;

/** Default dispute-window wait when the caller has no contract handle. */
export const DEFAULT_DISPUTE_WINDOW_SECONDS = 3_600;

/** Contract method names, kept together so the ABI stays discoverable. */
export const CONTRACT_METHODS = {
  init: 'init',
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
} as const;

/** Any error raised by the PulseRun client. */
export class PulseRunError extends Error {
  override readonly name = 'PulseRunError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Contract error codes (ABI — branch on the number, never renumber)
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  1: 'AlreadyInitialized',
  2: 'NotInitialized',
  3: 'JobNotFound',
  4: 'ProofNotFound',
  5: 'InvalidStatus',
  6: 'InvalidBudget',
  7: 'InvalidRate',
  8: 'InvalidDuration',
  9: 'DurationExceedsMax',
  10: 'Unauthorized',
  11: 'DisputeWindowActive',
  12: 'DisputeWindowElapsed',
  13: 'JobNotExpired',
  14: 'MathOverflow',
} as const;

export type ContractErrorName = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Resolves a numeric contract error code to its ABI name. */
export function errorName(code: number | bigint): ContractErrorName | undefined {
  return ERROR_CODES[Number(code) as keyof typeof ERROR_CODES];
}

/**
 * Pulls a contract error code out of an RPC error string such as
 * `HostError: Error(Contract, #5)`. Returns `null` when none is present.
 */
export function extractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  return match ? Number(match[1]) : null;
}

/** Formats an RPC error into a human message, resolving the ABI code name. */
export function describeContractError(message: string): string {
  const code = extractErrorCode(message);
  if (code === null) return message;
  const name = errorName(code);
  return name ? `${name} (contract error #${code})` : message;
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

export const JOB_STATUSES = ['Queued', 'Completed', 'Disputed', 'Settled', 'Refunded'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses from which a job can no longer change state (`JobStatus::is_terminal`). */
const TERMINAL_STATUSES: readonly JobStatus[] = ['Settled', 'Refunded'];

/** True once a job reached a terminal on-chain state. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Maps the contract's `status` field to a {@link JobStatus}.
 *
 * `#[contracttype]` unit enums are encoded as a `u32` discriminant; the symbol
 * form is also accepted so the client survives a representation change.
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

/** On-chain escrow record, mirroring the contract's `ComputeJob`. */
export interface ComputeJob {
  jobId: bigint;
  /** Address that funded the escrow. */
  requester: string;
  /** Address allowed to submit the proof. */
  runner: string;
  /** SEP-41 token (or its Stellar Asset Contract) used to denominate the job. */
  paymentToken: string;
  /** Absolute spend ceiling, in the token's base units. */
  maxBudget: bigint;
  /** Linear price charged per executed second, in base units. */
  ratePerSecond: bigint;
  /** Upper bound on billable seconds; also the unclaimed-job timeout. */
  maxDurationSecs: number;
  status: JobStatus;
  /** Ledger timestamp (seconds) the escrow opened. */
  createdAt: number;
  /** Ledger timestamp (seconds) the proof landed; `0` while queued. */
  completedAt: number;
  /** `0x`-prefixed SHA-256 commitment; the zero hash until a proof lands. */
  outputHash: string;
}

/** Runner's attestation that a job executed, mirroring `ExecutionProof`. */
export interface ExecutionProofRecord {
  jobId: bigint;
  /** Measured execution time in seconds. */
  durationSecs: number;
  exitCode: number;
  outputHash: string;
}

/** Zero 32-byte hash the contract stores before a proof lands. */
export const ZERO_HASH = `0x${'00'.repeat(32)}`;

/**
 * Unix timestamp (seconds) a `Completed` job becomes claimable once the
 * dispute window has elapsed.
 */
export function payoutReleaseAt(job: ComputeJob, disputeWindowSecs: number): number {
  return job.completedAt + disputeWindowSecs;
}

/** Seconds until a queued job's unclaimed-job timeout, negative once passed. */
export function expirySeconds(job: ComputeJob, nowSeconds: number): number {
  return job.createdAt + job.maxDurationSecs - nowSeconds;
}

// ---------------------------------------------------------------------------
// Token base-unit helpers
// ---------------------------------------------------------------------------

const DECIMAL_AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * Converts a decimal token amount into base units without going through a
 * float, e.g. `parseTokenAmount('1.5', 7) === 15_000_000n`.
 *
 * @throws {PulseRunError} when the amount is not a positive decimal with at
 *   most `decimals` places.
 */
export function parseTokenAmount(amount: string | number, decimals = 7): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new PulseRunError(`Invalid decimals "${String(decimals)}": expected 0..18.`);
  }
  const text = (typeof amount === 'number' ? String(amount) : amount).trim();
  if (!DECIMAL_AMOUNT_RE.test(text)) {
    throw new PulseRunError(
      `Invalid amount "${text}": expected a positive decimal such as "5" or "1.25".`,
    );
  }

  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) {
    throw new PulseRunError(
      `Invalid amount "${text}": at most ${decimals} decimal places are supported.`,
    );
  }

  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Converts base units back into a minimal decimal string for display. */
export function formatTokenAmount(amount: bigint, decimals = 7): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
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

function asInt(value: unknown, field: string): number {
  return Number(asBigInt(value, field));
}

/** Renders a `BytesN<32>` (or hex string) as an `0x…` hex digest. */
export function bytesToHex(value: unknown): string {
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'string') return value.startsWith('0x') ? value : `0x${value}`;
  throw new PulseRunError('Contract returned a non-bytes output hash.');
}

/**
 * Converts the native value returned by `get_job` into a {@link ComputeJob}.
 *
 * Exported because both `pulserun status` and the polling loop in
 * `pulserun run` need identical decoding.
 */
export function decodeComputeJob(value: unknown): ComputeJob {
  const raw = asRecord(value, 'ComputeJob');
  return {
    jobId: asBigInt(raw['job_id'] ?? raw['jobId'], 'job_id'),
    requester: asString(raw['requester'], 'requester'),
    runner: asString(raw['runner'], 'runner'),
    paymentToken: asString(raw['payment_token'] ?? raw['paymentToken'], 'payment_token'),
    maxBudget: asBigInt(raw['max_budget'] ?? raw['maxBudget'], 'max_budget'),
    ratePerSecond: asBigInt(raw['rate_per_second'] ?? raw['ratePerSecond'], 'rate_per_second'),
    maxDurationSecs: asInt(raw['max_duration_secs'] ?? raw['maxDurationSecs'], 'max_duration_secs'),
    status: decodeJobStatus(raw['status']),
    createdAt: asInt(raw['created_at'] ?? raw['createdAt'], 'created_at'),
    completedAt: asInt(raw['completed_at'] ?? raw['completedAt'], 'completed_at'),
    outputHash: bytesToHex(raw['output_hash'] ?? raw['outputHash']),
  };
}

/** Converts the native value returned by `get_proof` into a record. */
export function decodeExecutionProof(value: unknown): ExecutionProofRecord {
  const raw = asRecord(value, 'ExecutionProof');
  return {
    jobId: asBigInt(raw['job_id'] ?? raw['jobId'], 'job_id'),
    durationSecs: asInt(raw['duration_secs'] ?? raw['durationSecs'], 'duration_secs'),
    exitCode: asInt(raw['exit_code'] ?? raw['exitCode'], 'exit_code'),
    outputHash: bytesToHex(raw['output_hash'] ?? raw['outputHash']),
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
  /** Address allowed to execute the job and submit the proof. */
  runner: string;
  /** SEP-41 token (or its SAC) used to denominate the job. */
  paymentToken: string;
  /** Escrowed ceiling in the token's base units. */
  maxBudget: bigint;
  /** Linear price per executed second, in base units. */
  ratePerSecond: bigint;
  /** Upper bound on billable seconds; also the unclaimed-job timeout. */
  maxDurationSecs: number;
  /** Address funding the escrow; defaults to the signer. */
  requester?: string;
}

export interface SubmitProofParams {
  jobId: bigint | number | string;
  /** Measured execution time in seconds (`1..=max_duration_secs`). */
  durationSecs: number;
  /** Process exit code reported by the runner (i32). */
  exitCode: number;
  /** 32-byte SHA-256 commitment, as raw bytes or a hex digest. */
  outputHash: Uint8Array | string;
}

export interface TxResult {
  txHash: string;
  ledger: number;
}

export interface ClaimResult extends TxResult {
  /** Payout transferred to the runner, in base units. */
  earnings: bigint;
}

export interface JobSubmission extends TxResult {
  jobId: bigint;
}

export interface WaitForJobOptions {
  /** Overall polling budget in milliseconds. */
  timeoutMs?: number;
  /** Called after every successful poll. */
  onPoll?: (job: ComputeJob) => void;
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
        'A PulseRun escrow contract ID is required. Pass --contract or set PULSEESCROW_ID.',
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

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Invokes `create_job`, locking `maxBudget` base units in escrow, and waits
   * for the transaction to be included in a ledger.
   */
  async createJob(params: CreateJobParams): Promise<JobSubmission> {
    const signer = this.requireSigner();

    if (params.maxBudget <= 0n) {
      throw new PulseRunError('The max budget must be greater than zero.');
    }
    if (params.ratePerSecond <= 0n) {
      throw new PulseRunError('The rate per second must be greater than zero.');
    }
    if (!Number.isInteger(params.maxDurationSecs) || params.maxDurationSecs <= 0) {
      throw new PulseRunError('The max duration must be a whole number of seconds > 0.');
    }

    const requester = new Address(params.requester ?? signer.publicKey());
    const runner = parseAddress(params.runner, 'runner');
    const paymentToken = parseAddress(params.paymentToken, 'payment token');

    const operation = this.contract().call(
      CONTRACT_METHODS.createJob,
      requester.toScVal(),
      runner.toScVal(),
      paymentToken.toScVal(),
      nativeToScVal(params.maxBudget, { type: 'i128' }),
      nativeToScVal(params.ratePerSecond, { type: 'i128' }),
      nativeToScVal(params.maxDurationSecs, { type: 'u64' }),
    );

    const confirmation = await this.invoke(operation, signer);
    const returnValue = confirmation.returnValue;
    if (!returnValue) {
      throw new PulseRunError(
        `create_job confirmed but returned no job id (tx: ${confirmation.txHash}). Check that the contract ID is correct.`,
      );
    }

    return {
      jobId: asBigInt(scValToNative(returnValue), 'job_id'),
      txHash: confirmation.txHash,
      ledger: confirmation.ledger,
    };
  }

  /** Calls `submit_proof` as the runner. */
  async submitProof(params: SubmitProofParams): Promise<TxResult> {
    const signer = this.requireSigner();
    const operation = this.contract().call(
      CONTRACT_METHODS.submitProof,
      new Address(signer.publicKey()).toScVal(),
      encodeExecutionProof(params),
    );
    const confirmation = await this.invoke(operation, signer);
    return { txHash: confirmation.txHash, ledger: confirmation.ledger };
  }

  /**
   * Calls `claim_payout` for a completed job, returning the runner's earnings.
   * Callable by anyone once the dispute window has elapsed.
   */
  async claimPayout(jobId: bigint | number | string): Promise<ClaimResult> {
    const signer = this.requireSigner();
    const operation = this.contract().call(
      CONTRACT_METHODS.claimPayout,
      nativeToScVal(toJobId(jobId), { type: 'u64' }),
    );
    const confirmation = await this.invoke(operation, signer);
    const earnings = confirmation.returnValue
      ? asBigInt(scValToNative(confirmation.returnValue), 'earnings')
      : 0n;
    return { txHash: confirmation.txHash, ledger: confirmation.ledger, earnings };
  }

  /** Calls `dispute_job` as the requester, halting automatic payout. */
  async disputeJob(jobId: bigint | number | string): Promise<TxResult> {
    return this.requesterCall(CONTRACT_METHODS.disputeJob, jobId);
  }

  /** Calls `cancel_unclaimed_job` as the requester, refunding an unclaimed job. */
  async cancelUnclaimedJob(jobId: bigint | number | string): Promise<TxResult> {
    return this.requesterCall(CONTRACT_METHODS.cancelUnclaimedJob, jobId);
  }

  // -------------------------------------------------------------------------
  // Reads (simulated, no signing key required)
  // -------------------------------------------------------------------------

  /** Reads a job's current on-chain state. */
  async getJob(jobId: bigint | number | string): Promise<ComputeJob> {
    const retval = await this.simulateRead(
      CONTRACT_METHODS.getJob,
      nativeToScVal(toJobId(jobId), { type: 'u64' }),
    );
    return decodeComputeJob(scValToNative(retval));
  }

  /** Reads a job's proof, or `null` when none has landed yet. */
  async getProof(jobId: bigint | number | string): Promise<ExecutionProofRecord | null> {
    try {
      const retval = await this.simulateRead(
        CONTRACT_METHODS.getProof,
        nativeToScVal(toJobId(jobId), { type: 'u64' }),
      );
      return decodeExecutionProof(scValToNative(retval));
    } catch (error) {
      // ProofNotFound (code 4) simply means the runner has not proved yet.
      const code = (error as { cause?: { code?: number } } | undefined)?.cause?.code;
      if (error instanceof PulseRunError && code === 4) return null;
      throw error;
    }
  }

  /** Number of jobs ever created. */
  async getJobCount(): Promise<bigint> {
    const retval = await this.simulateRead(CONTRACT_METHODS.jobCount);
    return asBigInt(scValToNative(retval), 'job_count');
  }

  /** Configured dispute window, in seconds. */
  async getDisputeWindow(): Promise<number> {
    const retval = await this.simulateRead(CONTRACT_METHODS.disputeWindow);
    return asInt(scValToNative(retval), 'dispute_window');
  }

  /** Configured administrator address. */
  async getAdmin(): Promise<string> {
    const retval = await this.simulateRead(CONTRACT_METHODS.admin);
    return asString(scValToNative(retval), 'admin');
  }

  /**
   * Polls `get_job` until the job reaches a terminal state or `timeoutMs`
   * elapses. The last observed record is always returned, so callers can
   * distinguish "still open" from "finished".
   */
  async waitForJob(
    jobId: bigint | number | string,
    options: WaitForJobOptions = {},
  ): Promise<ComputeJob> {
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

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private contract(): Contract {
    return new Contract(this.contractId);
  }

  private requireSigner(): Keypair {
    if (!this.keypair) {
      throw new PulseRunError(
        'A Stellar secret key is required to sign this transaction. Pass --key or set PULSERUN_SECRET_KEY.',
      );
    }
    return this.keypair;
  }

  private async requesterCall(method: string, jobId: bigint | number | string): Promise<TxResult> {
    const signer = this.requireSigner();
    const operation = this.contract().call(
      method,
      new Address(signer.publicKey()).toScVal(),
      nativeToScVal(toJobId(jobId), { type: 'u64' }),
    );
    const confirmation = await this.invoke(operation, signer);
    return { txHash: confirmation.txHash, ledger: confirmation.ledger };
  }

  /** Builds, signs and submits a state-changing invocation. */
  private async invoke(
    operation: xdr.Operation,
    signer: Keypair,
  ): Promise<{ txHash: string; ledger: number; returnValue?: xdr.ScVal }> {
    const account = await this.server.getAccount(signer.publicKey());
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
      throw new PulseRunError(`The network rejected the transaction (${sent.hash}).`);
    }

    const confirmation = await this.server.pollTransaction(sent.hash, { attempts: 10 });
    if (confirmation.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new PulseRunError(
        `Transaction did not confirm (status: ${confirmation.status}, tx: ${sent.hash}).`,
      );
    }

    return {
      txHash: sent.hash,
      ledger: confirmation.ledger,
      returnValue: confirmation.returnValue,
    };
  }

  /**
   * Builds a transaction for a read-only contract call and simulates it.
   * When no signer is configured we use an ephemeral source account so that
   * `pulserun status` works without holding a key.
   */
  private async simulateRead(method: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const account = await this.resolveSourceAccount();
    const transaction = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract().call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      const code = extractErrorCode(simulation.error);
      throw new PulseRunError(
        `Simulating ${method} failed: ${describeContractError(simulation.error)}`,
        code === null ? undefined : { cause: { code } },
      );
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

// ---------------------------------------------------------------------------
// Argument encoding
// ---------------------------------------------------------------------------

/** Encodes a `ComputeJob` proof argument as an `ExecutionProof` map ScVal. */
export function encodeExecutionProof(params: SubmitProofParams): xdr.ScVal {
  const exitCode = Math.trunc(params.exitCode);
  if (!Number.isInteger(exitCode) || exitCode < -2_147_483_648 || exitCode > 2_147_483_647) {
    throw new PulseRunError(`Exit code ${String(params.exitCode)} is not a signed 32-bit integer.`);
  }
  if (!Number.isInteger(params.durationSecs) || params.durationSecs <= 0) {
    throw new PulseRunError('The proof duration must be a whole number of seconds > 0.');
  }

  const hash = toOutputHashBytes(params.outputHash);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('job_id'),
      val: nativeToScVal(toJobId(params.jobId), { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('duration_secs'),
      val: nativeToScVal(params.durationSecs, { type: 'u64' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('exit_code'),
      val: nativeToScVal(exitCode, { type: 'i32' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('output_hash'),
      val: nativeToScVal(hash, { type: 'bytes' }),
    }),
  ]);
}

/** Normalises a hex digest or raw bytes into the 32 bytes the contract wants. */
export function toOutputHashBytes(value: Uint8Array | string): Uint8Array {
  const bytes =
    typeof value === 'string'
      ? Buffer.from(value.trim().toLowerCase().replace(/^0x/, ''), 'hex')
      : Buffer.from(value);
  if (bytes.length !== 32) {
    throw new PulseRunError(`Output hash must be 32 bytes; received ${bytes.length}.`);
  }
  return new Uint8Array(bytes);
}

/** Validates a Stellar address string (`G...`, `C...` or `M...`). */
export function parseAddress(value: string, field: string): Address {
  try {
    return new Address(value.trim());
  } catch (error) {
    throw new PulseRunError(`Invalid ${field} "${value}": expected a Stellar address.`, {
      cause: error,
    });
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
      throw new PulseRunError(
        `Invalid job id "${String(jobId)}": expected a non-negative integer.`,
      );
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
