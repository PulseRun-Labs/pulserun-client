import { describe, expect, it } from 'vitest';
import {
  parseDecimals,
  parsePositiveMs,
  parsePositiveSeconds,
  resolveConnection,
  resolvePaymentToken,
  resolveSecretKey,
} from '../src/config.js';
import { NETWORK_PRESETS, PulseRunError } from '../src/client/soroban.js';

const CONTRACT_ID = 'C'.padEnd(56, 'B');
const TOKEN_ID = 'C'.padEnd(56, 'T');

describe('resolveConnection', () => {
  it('uses the network preset by default', () => {
    const resolved = resolveConnection({ contract: CONTRACT_ID }, {});
    expect(resolved.network).toBe('testnet');
    expect(resolved.rpcUrl).toBe(NETWORK_PRESETS.testnet.rpcUrl);
    expect(resolved.networkPassphrase).toBe(NETWORK_PRESETS.testnet.networkPassphrase);
  });

  it('prefers flags over environment variables', () => {
    const resolved = resolveConnection(
      { network: 'mainnet', rpcUrl: 'https://custom.test', contract: CONTRACT_ID },
      {
        PULSERUN_NETWORK: 'testnet',
        STELLAR_RPC_URL: 'https://env.test',
        PULSEESCROW_ID: 'Cenv',
      },
    );
    expect(resolved.network).toBe('mainnet');
    expect(resolved.rpcUrl).toBe('https://custom.test');
    expect(resolved.contractId).toBe(CONTRACT_ID);
  });

  it('reads PULSEESCROW_ID and STELLAR_RPC_URL from the environment', () => {
    const resolved = resolveConnection(
      {},
      { PULSERUN_NETWORK: 'local', PULSEESCROW_ID: CONTRACT_ID, STELLAR_RPC_URL: 'https://x.test' },
    );
    expect(resolved.network).toBe('local');
    expect(resolved.rpcUrl).toBe('https://x.test');
    expect(resolved.contractId).toBe(CONTRACT_ID);
  });

  it('honours a network passphrase override', () => {
    const resolved = resolveConnection(
      { contract: CONTRACT_ID },
      {
        STELLAR_NETWORK_PASSPHRASE: 'Custom ; Network',
      },
    );
    expect(resolved.networkPassphrase).toBe('Custom ; Network');
  });

  it('requires a contract id', () => {
    expect(() => resolveConnection({}, {})).toThrowError(PulseRunError);
    expect(() => resolveConnection({}, {})).toThrowError(/Missing escrow contract ID/);
    expect(() => resolveConnection({ contract: '   ' }, {})).toThrowError(
      /Missing escrow contract ID/,
    );
  });
});

describe('resolveSecretKey', () => {
  it('prefers the flag then the environment', () => {
    expect(resolveSecretKey({ key: 'SFLAG' }, { PULSERUN_SECRET_KEY: 'SENV' })).toBe('SFLAG');
    expect(resolveSecretKey({}, { PULSERUN_SECRET_KEY: 'SENV' })).toBe('SENV');
  });

  it('requires a key', () => {
    expect(() => resolveSecretKey({}, {})).toThrowError(/Missing Stellar secret key/);
  });
});

describe('resolvePaymentToken', () => {
  it('prefers the flag, then MOCKTOKEN_ID, then PAYMENT_TOKEN_ID', () => {
    expect(resolvePaymentToken({ token: TOKEN_ID }, { MOCKTOKEN_ID: 'Cenv' })).toBe(TOKEN_ID);
    expect(resolvePaymentToken({}, { MOCKTOKEN_ID: TOKEN_ID })).toBe(TOKEN_ID);
    expect(resolvePaymentToken({}, { PAYMENT_TOKEN_ID: TOKEN_ID })).toBe(TOKEN_ID);
  });

  it('requires a token', () => {
    expect(() => resolvePaymentToken({}, {})).toThrowError(/Missing payment token ID/);
  });
});

describe('parseDecimals', () => {
  it('defaults and validates', () => {
    expect(parseDecimals(undefined)).toBe(7);
    expect(parseDecimals('0')).toBe(0);
    expect(parseDecimals('18')).toBe(18);
    expect(() => parseDecimals('19')).toThrowError(/expected an integer 0\.\.18/);
    expect(() => parseDecimals('2.5')).toThrowError(PulseRunError);
  });
});

describe('duration parsers', () => {
  it('returns the fallback for empty values', () => {
    expect(parsePositiveSeconds(undefined, 'max-duration', 900)).toBe(900);
    expect(parsePositiveSeconds('', 'max-duration', 900)).toBe(900);
    expect(parsePositiveMs(undefined, 'poll-interval', 4000)).toBe(4000);
  });

  it('parses and floors valid values', () => {
    expect(parsePositiveSeconds('12', 'max-duration', 900)).toBe(12);
    expect(parsePositiveSeconds(12.9, 'max-duration', 900)).toBe(12);
    expect(parsePositiveMs('2500', 'poll-interval', 4000)).toBe(2500);
  });

  it('rejects non-positive values', () => {
    expect(() => parsePositiveSeconds('0', 'max-duration', 900)).toThrowError(
      /expected a number of seconds > 0/,
    );
    expect(() => parsePositiveMs('-1', 'poll-interval', 4000)).toThrowError(/milliseconds > 0/);
    expect(() => parsePositiveSeconds('soon', 'max-duration', 900)).toThrowError(PulseRunError);
  });
});
