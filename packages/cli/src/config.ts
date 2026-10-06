/**
 * CLI configuration resolution.
 *
 * Every command accepts flags first and falls back to `PULSERUN_*` environment
 * variables, which lets CI pipelines configure the CLI once instead of on
 * every invocation.
 */

import { DEFAULT_NETWORK, PulseRunError, resolveNetwork } from './client/soroban.js';

export interface ConnectionOptions {
  /** `testnet` | `futurenet` | `mainnet` | `local`. */
  network?: string;
  /** Soroban RPC endpoint override. */
  rpcUrl?: string;
  /** PulseRun escrow contract ID. */
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
  const rpcUrl = options.rpcUrl ?? env.PULSERUN_RPC_URL ?? preset.rpcUrl;
  const contractId = (options.contract ?? env.PULSERUN_CONTRACT_ID ?? '').trim();

  if (!contractId) {
    throw new PulseRunError(
      'Missing escrow contract ID. Pass --contract <C...> or set PULSERUN_CONTRACT_ID.',
    );
  }

  return { network, rpcUrl, networkPassphrase: preset.networkPassphrase, contractId };
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

/** Parses a positive integer number of seconds, e.g. `--timeout 900`. */
export function parsePositiveSeconds(
  value: string | number | undefined,
  field: string,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PulseRunError(`Invalid ${field} "${String(value)}": expected a number of seconds > 0.`);
  }
  return Math.floor(parsed);
}
