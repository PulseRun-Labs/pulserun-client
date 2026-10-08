/**
 * Runner-side access to the PulseEscrow contract.
 *
 * The daemon needs three reads (`job_count`, `get_job`, `dispute_window`) and
 * two writes (`submit_proof`, `claim_payout`). Keeping them behind the narrow
 * {@link EscrowReader} / {@link EscrowWriter} interfaces lets the runner loop
 * be unit-tested without a network.
 *
 * ## Contract interface (pulserun-core)
 *
 * ```text
 * create_job(requester, runner, payment_token, max_budget,
 *            rate_per_second, max_duration_secs) -> u64
 * submit_proof(runner: Address, proof: ExecutionProof) -> ()
 * claim_payout(job_id: u64) -> i128
 * get_job(job_id: u64) -> ComputeJob
 * job_count() -> u64
 * dispute_window() -> u64
 * ```
 */

import {
  type Account,
  type Transaction,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { DaemonError } from './config.js';

/** Contract method names the runner calls. */
export const CONTRACT_METHODS = {
  submitProof: 'submit_proof',
  claimPayout: 'claim_payout',
  getJob: 'get_job',
  jobCount: 'job_count',
  disputeWindow: 'dispute_window',
} as const;

/** Lifecycle statuses, mirroring the contract's `JobStatus`. */
export const JOB_STATUSES = ['Queued', 'Completed', 'Disputed', 'Settled', 'Refunded'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** On-chain escrow record, mirroring the contract's `ComputeJob`. */
export interface ComputeJob {
  jobId: bigint;
  requester: string;
  runner: string;
  paymentToken: string;
  maxBudget: bigint;
  ratePerSecond: bigint;
  maxDurationSecs: number;
  status: JobStatus;
  createdAt: number;
  completedAt: number;
  outputHash: string;
}

export interface TxResult {
  txHash: string;
  ledger: number;
}

export interface ClaimResult extends TxResult {
  earnings: bigint;
}

export interface SubmitProofParams {
  jobId: bigint;
  durationSecs: number;
  exitCode: number;
  /** 32 raw SHA-256 bytes (or a hex digest). */
  outputHash: Uint8Array | string;
}

/** Read surface the watcher depends on. */
export interface EscrowReader {
  jobCount(): Promise<bigint>;
  getJob(jobId: bigint): Promise<ComputeJob>;
  disputeWindow(): Promise<number>;
}

/** Write surface the runner depends on. */
export interface EscrowWriter {
  submitProof(params: SubmitProofParams): Promise<TxResult>;
  claimPayout(jobId: bigint): Promise<ClaimResult>;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DaemonError(`Contract returned an unexpected value for "${field}".`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new DaemonError(`Contract returned a non-string "${field}".`);
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new DaemonError(`Contract returned a non-integer "${field}".`);
}

function asInt(value: unknown, field: string): number {
  return Number(asBigInt(value, field));
}

function bytesToHex(value: unknown): string {
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  if (typeof value === 'string') return value.startsWith('0x') ? value : `0x${value}`;
  throw new DaemonError('Contract returned a non-bytes output hash.');
}

/** Maps the contract's `status` field to a {@link JobStatus}. */
export function decodeJobStatus(value: unknown): JobStatus {
  if (typeof value === 'string') {
    const match = JOB_STATUSES.find((status) => status.toLowerCase() === value.toLowerCase());
    if (match) return match;
    throw new DaemonError(`Unknown job status "${value}".`);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const status = JOB_STATUSES[Number(value)];
    if (status) return status;
    throw new DaemonError(`Unknown job status discriminant ${String(value)}.`);
  }
  throw new DaemonError('The contract did not return a usable job status.');
}

/** Converts the native value returned by `get_job` into a {@link ComputeJob}. */
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

// ---------------------------------------------------------------------------
// RPC server
// ---------------------------------------------------------------------------

/** The subset of `rpc.Server` the runner needs, so tests can fake it. */
export interface ContractRpcServer {
  getAccount(address: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(
    hash: string,
    options?: { attempts?: number },
  ): Promise<rpc.Api.GetTransactionResponse>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
}

export interface RunnerEscrowOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  /** Runner secret key used to sign `submit_proof` and `claim_payout`. */
  secretKey: string;
  /** RPC override, primarily for tests. */
  server?: ContractRpcServer;
  /** Transaction fee in stroops; defaults to `BASE_FEE`. */
  fee?: string;
  pollAttempts?: number;
}

/** Reads and writes the PulseEscrow contract on behalf of a runner. */
export class RunnerEscrow implements EscrowReader, EscrowWriter {
  private readonly server: ContractRpcServer;
  private readonly keypair: Keypair;
  private readonly fee: string;
  private readonly pollAttempts: number;
  private readonly contractId: string;

  constructor(private readonly options: RunnerEscrowOptions) {
    if (!options.contractId) {
      throw new DaemonError('A PulseEscrow contract ID is required.');
    }
    this.contractId = options.contractId;
    this.keypair = parseSecretKey(options.secretKey);
    this.fee = options.fee ?? BASE_FEE;
    this.pollAttempts = options.pollAttempts ?? 10;
    this.server =
      options.server ??
      new rpc.Server(options.rpcUrl, { allowHttp: options.rpcUrl.startsWith('http://') });
  }

  /** The runner public key that signs every write. */
  get publicKey(): string {
    return this.keypair.publicKey();
  }

  // -- reads ----------------------------------------------------------------

  async jobCount(): Promise<bigint> {
    return asBigInt(scValToNative(await this.simulate(CONTRACT_METHODS.jobCount)), 'job_count');
  }

  async getJob(jobId: bigint): Promise<ComputeJob> {
    const retval = await this.simulate(
      CONTRACT_METHODS.getJob,
      nativeToScVal(jobId, { type: 'u64' }),
    );
    return decodeComputeJob(scValToNative(retval));
  }

  async disputeWindow(): Promise<number> {
    const retval = await this.simulate(CONTRACT_METHODS.disputeWindow);
    return asInt(scValToNative(retval), 'dispute_window');
  }

  // -- writes ---------------------------------------------------------------

  async submitProof(params: SubmitProofParams): Promise<TxResult> {
    const operation = this.contract().call(
      CONTRACT_METHODS.submitProof,
      new Address(this.publicKey).toScVal(),
      encodeExecutionProof(params),
    );
    const { txHash, ledger } = await this.invoke(operation);
    return { txHash, ledger };
  }

  async claimPayout(jobId: bigint): Promise<ClaimResult> {
    const operation = this.contract().call(
      CONTRACT_METHODS.claimPayout,
      nativeToScVal(jobId, { type: 'u64' }),
    );
    const { txHash, ledger, returnValue } = await this.invoke(operation);
    const earnings = returnValue ? asBigInt(scValToNative(returnValue), 'earnings') : 0n;
    return { txHash, ledger, earnings };
  }

  // -- internals ------------------------------------------------------------

  private contract(): Contract {
    return new Contract(this.contractId);
  }

  private async simulate(method: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const account = await this.server.getAccount(this.publicKey);
    const transaction = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.options.networkPassphrase,
    })
      .addOperation(this.contract().call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new DaemonError(`Simulating ${method} failed: ${simulation.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new DaemonError(`Simulating ${method} returned no value.`);
    }
    return simulation.result.retval;
  }

  private async invoke(
    operation: xdr.Operation,
  ): Promise<{ txHash: string; ledger: number; returnValue?: xdr.ScVal }> {
    const account = await this.server.getAccount(this.publicKey);
    const transaction = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.options.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    prepared.sign(this.keypair);

    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new DaemonError(`The network rejected the transaction (${sent.hash}).`);
    }

    const confirmation = await this.server.pollTransaction(sent.hash, {
      attempts: this.pollAttempts,
    });
    if (confirmation.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new DaemonError(
        `Transaction did not confirm (status: ${confirmation.status}, tx: ${sent.hash}).`,
      );
    }

    return {
      txHash: sent.hash,
      ledger: confirmation.ledger,
      returnValue: confirmation.returnValue,
    };
  }
}

/** Encodes an `ExecutionProof` argument as the contract's map ScVal. */
export function encodeExecutionProof(params: SubmitProofParams): xdr.ScVal {
  const exitCode = Math.trunc(params.exitCode);
  if (!Number.isInteger(exitCode) || exitCode < -2_147_483_648 || exitCode > 2_147_483_647) {
    throw new DaemonError(`Exit code ${String(params.exitCode)} is not a signed 32-bit integer.`);
  }
  if (!Number.isInteger(params.durationSecs) || params.durationSecs <= 0) {
    throw new DaemonError('The proof duration must be a whole number of seconds > 0.');
  }

  const hash = toOutputHashBytes(params.outputHash);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('job_id'),
      val: nativeToScVal(params.jobId, { type: 'u64' }),
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
    throw new DaemonError(`Output hash must be 32 bytes; received ${bytes.length}.`);
  }
  return new Uint8Array(bytes);
}

function parseSecretKey(secret: string): Keypair {
  try {
    return Keypair.fromSecret(secret.trim());
  } catch (error) {
    throw new DaemonError('Could not parse PULSERUN_SECRET_KEY: expected an S... seed.', {
      cause: error,
    });
  }
}
