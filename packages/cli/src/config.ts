/**
 * CLI configuration resolution.
 *
 * Every command accepts flags first and falls back to environment variables,
 * which lets CI pipelines configure the CLI once instead of on every
 * invocation. Contract and token ids are never guessed: they come from flags
 * or the deployed values recorded in pulserun-core's
 * `docs/deployments/testnet.md`.
 */

import { DEFAULT_NETWORK, PulseRunError, resolveNetwork } from './client/soroban.js';

export interface ConnectionOptions {
  /** `testnet` | `futurenet` | `mainnet` | `local`. */
  network?: string;
  /** Soroban RPC endpoint override. */
  rpcUrl?: string;
  /** Network passphrase override; defaults to the preset for `network`. */
  networkPassphrase?: string;
  /** PulseEscrow contract ID. */
  contract?: string;
}

export interface ResolvedConnection {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
}

/**
 * Resolves the network preset, RPC URL and contract ID for a command.
 *
 * @throws {PulseRunError} when no contract ID can be determined.
 */
export function resolveConnection(
  options: ConnectionOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConnection {
  const network = options.network ?? env.PULSERUN_NETWORK ?? DEFAULT_NETWORK;
  const preset = resolveNetwork(network);
  const rpcUrl = options.rpcUrl ?? env.STELLAR_RPC_URL ?? preset.rpcUrl;
  const networkPassphrase =
    options.networkPassphrase ?? env.STELLAR_NETWORK_PASSPHRASE ?? preset.networkPassphrase;
  const contractId = (options.contract ?? env.PULSEESCROW_ID ?? '').trim();

  if (!contractId) {
    throw new PulseRunError(
      'Missing escrow contract ID. Pass --contract <C...> or set PULSEESCROW_ID.',
    );
  }

  return { network, rpcUrl, networkPassphrase, contractId };
}

/** Resolves the signing key from `--key` or `PULSERUN_SECRET_KEY`. */
export function resolveSecretKey(
  options: { key?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = (options.key ?? env.PULSERUN_SECRET_KEY ?? '').trim();
  if (!secret) {
    throw new PulseRunError(
      'Missing Stellar secret key. Pass --key <S...> or set PULSERUN_SECRET_KEY.',
    );
  }
  return secret;
}

/**
 * Resolves the payment token used to denominate a job.
 *
 * `--token` wins, then `MOCKTOKEN_ID`, then `PAYMENT_TOKEN_ID`.
 */
export function resolvePaymentToken(
  options: { token?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const token = (options.token ?? env.MOCKTOKEN_ID ?? env.PAYMENT_TOKEN_ID ?? '').trim();
  if (!token) {
    throw new PulseRunError(
      'Missing payment token ID. Pass --token <C...> or set MOCKTOKEN_ID / PAYMENT_TOKEN_ID.',
    );
  }
  return token;
}

/** Parses a token's decimal precision, e.g. `--decimals 7`. */
export function parseDecimals(value: string | number | undefined, fallback = 7): number {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) {
    throw new PulseRunError(`Invalid decimals "${String(value)}": expected an integer 0..18.`);
  }
  return parsed;
}

/** Parses a positive integer number of seconds, e.g. `--max-duration 900`. */
export function parsePositiveSeconds(
  value: string | number | undefined,
  field: string,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PulseRunError(
      `Invalid ${field} "${String(value)}": expected a number of seconds > 0.`,
    );
  }
  return Math.floor(parsed);
}

/** Parses a positive duration in milliseconds, e.g. `--poll-interval 4000`. */
export function parsePositiveMs(
  value: string | number | undefined,
  field: string,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PulseRunError(
      `Invalid ${field} "${String(value)}": expected a number of milliseconds > 0.`,
    );
  }
  return Math.floor(parsed);
}
