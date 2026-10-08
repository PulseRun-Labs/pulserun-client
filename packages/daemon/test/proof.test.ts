import { describe, expect, it } from 'vitest';
import { DaemonError } from '../src/config.js';
import {
  TIMEOUT_EXIT_CODE,
  buildProof,
  formatProof,
  hashLogs,
  hexToBytes,
  normaliseHash,
  outputHashBytes,
} from '../src/proof.js';

const HASH = 'ab'.repeat(32);

describe('hashLogs', () => {
  it('matches the well-known SHA-256 vectors', () => {
    expect(hashLogs('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashLogs('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes bytes and strings identically and yields 32 bytes', () => {
    expect(hashLogs(Buffer.from('hello'))).toBe(hashLogs('hello'));
    expect(outputHashBytes('hello')).toHaveLength(32);
    expect(outputHashBytes('hello')).toBeInstanceOf(Uint8Array);
  });
});

describe('normaliseHash', () => {
  it('accepts prefixed and bare digests', () => {
    expect(normaliseHash(HASH)).toBe(HASH);
    expect(normaliseHash(`0x${HASH.toUpperCase()}`)).toBe(HASH);
    expect(normaliseHash(` ${HASH} `)).toBe(HASH);
  });

  it('rejects anything that is not a 32-byte digest', () => {
    expect(() => normaliseHash('deadbeef')).toThrowError(DaemonError);
    expect(() => normaliseHash('zz'.repeat(32))).toThrowError(/not a 32-byte SHA-256 hex digest/);
  });

  it('converts hex into bytes', () => {
    expect(hexToBytes(HASH)).toHaveLength(32);
    expect([...hexToBytes(`0x${'00'.repeat(31)}0a`)].at(-1)).toBe(0x0a);
    expect(Buffer.from(outputHashBytes('hello')).toString('hex')).toBe(hashLogs('hello'));
  });
});

describe('buildProof', () => {
  it('reports the metered duration in whole seconds', () => {
    const proof = buildProof({ exitCode: 0, logs: 'ok', durationMs: 12_400 });
    expect(proof).toEqual({ outputHash: hashLogs('ok'), durationSecs: 13, exitCode: 0 });
  });

  it('floors the duration at one second', () => {
    expect(buildProof({ exitCode: 0, logs: 'ok', durationMs: 0 }).durationSecs).toBe(1);
    expect(buildProof({ exitCode: 0, logs: 'ok', durationMs: 250 }).durationSecs).toBe(1);
  });

  it('reports the timeout exit code when the sandbox was killed', () => {
    const proof = buildProof({ exitCode: 0, logs: 'partial', durationMs: 1_000, timedOut: true });
    expect(proof.exitCode).toBe(TIMEOUT_EXIT_CODE);
  });

  it('keeps a non-zero exit code', () => {
    expect(buildProof({ exitCode: 137, logs: 'boom', durationMs: 1_000 }).exitCode).toBe(137);
  });

  it('formats a compact one-line summary', () => {
    expect(formatProof(12n, { outputHash: HASH, durationSecs: 20, exitCode: 0 })).toBe(
      '#12 sha256:abababababab… 20s exit 0',
    );
  });
});
