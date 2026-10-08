import { describe, expect, it } from 'vitest';
import {
  parsePositiveMs,
  parsePositiveSeconds,
  resolveConnection,
  resolveSecretKey,
} from '../src/config.js';
import { NETWORK_PRESETS, PulseRunError } from '../src/client/soroban.js';

const CONTRACT_ID = 'C'.padEnd(56, 'B');

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
        PULSERUN_RPC_URL: 'https://env.test',
        PULSERUN_CONTRACT_ID: 'Cenv',
      },
    );
    expect(resolved.network).toBe('mainnet');
    expect(resolved.rpcUrl).toBe('https://custom.test');
    expect(resolved.contractId).toBe(CONTRACT_ID);
  });

  it('falls back to environment variables', () => {
    const resolved = resolveConnection(
      {},
      { PULSERUN_NETWORK: 'local', PULSERUN_CONTRACT_ID: CONTRACT_ID },
    );
    expect(resolved.network).toBe('local');
    expect(resolved.rpcUrl).toBe(NETWORK_PRESETS.local.rpcUrl);
  });

  it('requires a contract id', () => {
    expect(() => resolveConnection({}, {})).toThrowError(PulseRunError);
    expect(() => resolveConnection({}, {})).toThrowError(/Missing escrow contract ID/);
  });

  it('ignores a blank contract id', () => {
    expect(() => resolveConnection({ contract: '   ' }, {})).toThrowError(
      /Missing escrow contract ID/,
    );
  });
});

describe('resolveSecretKey', () => {
  it('prefers the flag', () => {
    expect(resolveSecretKey({ key: 'SFLAG' }, { PULSERUN_SECRET_KEY: 'SENV' })).toBe('SFLAG');
  });

  it('falls back to the environment', () => {
    expect(resolveSecretKey({}, { PULSERUN_SECRET_KEY: 'SENV' })).toBe('SENV');
  });

  it('requires a key', () => {
    expect(() => resolveSecretKey({}, {})).toThrowError(/Missing Stellar secret key/);
  });
});

describe('duration parsers', () => {
  it('returns the fallback for empty values', () => {
    expect(parsePositiveSeconds(undefined, 'timeout', 900)).toBe(900);
    expect(parsePositiveSeconds('', 'timeout', 900)).toBe(900);
    expect(parsePositiveMs(undefined, 'poll-interval', 4000)).toBe(4000);
  });

  it('parses and floors valid values', () => {
    expect(parsePositiveSeconds('12', 'timeout', 900)).toBe(12);
    expect(parsePositiveSeconds(12.9, 'timeout', 900)).toBe(12);
    expect(parsePositiveMs('2500', 'poll-interval', 4000)).toBe(2500);
  });

  it('rejects non-positive values', () => {
    expect(() => parsePositiveSeconds('0', 'timeout', 900)).toThrowError(
      /expected a number of seconds > 0/,
    );
    expect(() => parsePositiveMs('-1', 'poll-interval', 4000)).toThrowError(/milliseconds > 0/);
    expect(() => parsePositiveSeconds('soon', 'timeout', 900)).toThrowError(PulseRunError);
  });
});
