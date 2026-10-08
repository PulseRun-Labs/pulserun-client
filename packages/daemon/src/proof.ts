/**
 * Execution proofs.
 *
 * A runner never uploads logs on-chain. It hashes the sandbox output with
 * SHA-256 and submits `submit_proof(runner, job_id, output_hash, exit_code,
 * success)` to the escrow contract, which releases (or refunds) the escrow.
 * Anyone can later re-run the job in the same image and compare hashes.
 *
 * ## Expected contract interface
 *
 * ```text
 * submit_proof(runner: Address, job_id: u64, output_hash: BytesN<32>,
 *              exit_code: i32, success: bool) -> ()
 * ```
 */

import { createHash } from 'node:crypto';
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
} from '@stellar/stellar-sdk';
import { DaemonError } from './config.js';

/** Contract method that records an execution proof. */
export const SUBMIT_PROOF_METHOD = 'submit_proof';

/** Hash function used for output hashes; part of the on-chain ABI. */
export const PROOF_HASH_ALGORITHM = 'sha256';

/** Length of a SHA-256 digest in bytes (`BytesN<32>` on-chain). */
export const OUTPUT_HASH_BYTES = 32;

/** Conventional exit code reported when a sandbox hit its wall-clock limit. */
export const TIMEOUT_EXIT_CODE = 124;

/** Hashes sandbox output into a lowercase, unprefixed hex digest. */
export function hashLogs(logs: string | Uint8Array): string {
  return createHash(PROOF_HASH_ALGORITHM).update(logs).digest('hex');
}

/** Hashes sandbox output into the raw 32 bytes the contract expects. */
export function outputHashBytes(logs: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash(PROOF_HASH_ALGORITHM).update(logs).digest());
}

/** Normalises a hex digest (`0x…` or bare) to lowercase, unprefixed hex. */
export function normaliseHash(hash: string): string {
  const value = hash.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new DaemonError(`"${hash}" is not a 32-byte SHA-256 hex digest.`);
  }
  return value;
}

/** Converts a hex digest into the raw bytes sent to the contract. */
export function hexToBytes(hash: string): Uint8Array {
  return new Uint8Array(Buffer.from(normaliseHash(hash), 'hex'));
}

export interface ExecutionOutcome {
  exitCode: number;
  logs: string | Uint8Array;
  /** True when the sandbox was killed because it exceeded its deadline. */
  timedOut?: boolean;
}

export interface ExecutionProof {
  /** Lowercase hex SHA-256 of the sandbox output. */
  outputHash: string;
  exitCode: number;
  success: boolean;
}

/**
 * Builds the proof payload for a finished sandbox run.
 *
 * `success` requires a zero exit code *and* that the container was not killed
 * for exceeding its time budget.
 */
export function buildProof(outcome: ExecutionOutcome): ExecutionProof {
  const timedOut = outcome.timedOut ?? false;
  return {
    outputHash: hashLogs(outcome.logs),
    exitCode: outcome.exitCode,
    success: !timedOut && outcome.exitCode === 0,
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface SubmitProofParams {
  jobId: bigint;
  /** Lowercase hex SHA-256 digest, with or without `0x`. */
  outputHash: string;
  exitCode: number;
  success: boolean;
}

export interface ProofSubmission {
  txHash: string;
  ledger: number;
  outputHash: string;
}

/** Submits execution proofs to the escrow contract. */
export interface ProofSubmitter {
  submit(params: SubmitProofParams): Promise<ProofSubmission>;
}

/**
 * The subset of `rpc.Server` the submitter needs; narrowing it keeps the
 * submitter unit-testable with a lightweight fake.
 */
export interface ProofRpcServer {
  getAccount(address: string): Promise<Account>;
  prepareTransaction(tx: Transaction): Promise<Transaction>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(
    hash: string,
    options?: { attempts?: number },
  ): Promise<rpc.Api.GetTransactionResponse>;
}

export interface SorobanProofSubmitterOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  /** Runner secret key used to sign `submit_proof`. */
  secretKey: string;
  /** RPC override, primarily for tests. */
  server?: ProofRpcServer;
  /** Transaction fee in stroops; defaults to `BASE_FEE`. */
  fee?: string;
  /** How many ledgers to wait for confirmation. */
  pollAttempts?: number;
}

/** Submits `submit_proof` transactions to the PulseRun escrow contract. */
export class SorobanProofSubmitter implements ProofSubmitter {
  private readonly server: ProofRpcServer;
  private readonly keypair: Keypair;
  private readonly fee: string;
  private readonly pollAttempts: number;

  constructor(private readonly options: SorobanProofSubmitterOptions) {
    if (!options.contractId) {
      throw new DaemonError('A PulseRun escrow contract ID is required to submit proofs.');
    }
    this.keypair = parseSecretKey(options.secretKey);
    this.fee = options.fee ?? BASE_FEE;
    this.pollAttempts = options.pollAttempts ?? 10;
    this.server =
      options.server ??
      new rpc.Server(options.rpcUrl, { allowHttp: options.rpcUrl.startsWith('http://') });
  }

  /** The runner public key that signs every proof. */
  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async submit(params: SubmitProofParams): Promise<ProofSubmission> {
    const exitCode = Math.trunc(params.exitCode);
    if (!Number.isInteger(exitCode) || exitCode < -2_147_483_648 || exitCode > 2_147_483_647) {
      throw new DaemonError(`Exit code ${String(params.exitCode)} is not a signed 32-bit integer.`);
    }

    const outputHash = normaliseHash(params.outputHash);
    const account = await this.server.getAccount(this.publicKey);
    const contract = new Contract(this.options.contractId);

    const operation = contract.call(
      SUBMIT_PROOF_METHOD,
      new Address(this.publicKey).toScVal(),
      nativeToScVal(params.jobId, { type: 'u64' }),
      nativeToScVal(hexToBytes(outputHash), { type: 'bytes' }),
      nativeToScVal(exitCode, { type: 'i32' }),
      nativeToScVal(params.success, { type: 'bool' }),
    );

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
      throw new DaemonError(`The network rejected submit_proof (${sent.hash}).`);
    }

    const confirmation = await this.server.pollTransaction(sent.hash, {
      attempts: this.pollAttempts,
    });
    if (confirmation.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new DaemonError(
        `submit_proof did not confirm (status: ${confirmation.status}, tx: ${sent.hash}).`,
      );
    }

    return { txHash: sent.hash, ledger: confirmation.ledger, outputHash };
  }
}

/** Formats a proof for logs: `#12 sha256:abcd… exit 0 ✓`. */
export function formatProof(jobId: bigint, proof: ExecutionProof): string {
  const prefix = proof.outputHash.slice(0, 12);
  return `#${jobId} sha256:${prefix}… exit ${proof.exitCode} ${proof.success ? '✓' : '✗'}`;
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
