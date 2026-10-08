import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DaemonError,
  NETWORK_PRESETS,
  createLogger,
  dockerOptionsFromHost,
  loadConfig,
  resolveNetwork,
  silentLogger,
} from '../src/config.js';

const TESTNET = resolveNetwork('testnet');
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const SECRET = Keypair.random().secret();
const RUNNER = Keypair.fromSecret(SECRET).publicKey();

const BASE_ENV: NodeJS.ProcessEnv = {
  PULSEESCROW_ID: CONTRACT_ID,
  PULSERUN_SECRET_KEY: SECRET,
};

function collect(): { stream: NodeJS.WritableStream; lines: () => string[] } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    lines: () => {
      const text = chunks.join('');
      return text === '' ? [] : text.trimEnd().split('\n');
    },
  };
}

describe('resolveNetwork', () => {
  it('resolves presets and defaults to testnet', () => {
    expect(resolveNetwork(undefined)).toEqual(NETWORK_PRESETS.testnet);
    expect(resolveNetwork('MainNet')).toEqual(NETWORK_PRESETS.mainnet);
  });

  it('rejects unknown networks', () => {
    expect(() => resolveNetwork('moon')).toThrowError(DaemonError);
    expect(() => resolveNetwork('moon')).toThrowError(/Unknown network "moon"/);
  });
});

describe('loadConfig', () => {
  it('applies defaults and derives the runner public key', () => {
    const config = loadConfig(BASE_ENV);

    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe(TESTNET.rpcUrl);
    expect(config.networkPassphrase).toBe(TESTNET.networkPassphrase);
    expect(config.runnerPublicKey).toBe(RUNNER);
    expect(config.pollIntervalMs).toBe(DEFAULT_CONFIG.pollIntervalMs);
    expect(config.jobSpecsFile).toBe(DEFAULT_CONFIG.jobSpecsFile);
    expect(config.cpuLimit).toBe(DEFAULT_CONFIG.cpuLimit);
    expect(config.allowNetwork).toBe(false);
    expect(config.autoClaimPayout).toBe(true);
    expect(config.once).toBe(false);
  });

  it('accepts the legacy PULSERUN_CONTRACT_ID alias', () => {
    const config = loadConfig({ PULSERUN_CONTRACT_ID: CONTRACT_ID, PULSERUN_SECRET_KEY: SECRET });
    expect(config.contractId).toBe(CONTRACT_ID);
  });

  it('honours environment overrides', () => {
    const config = loadConfig({
      ...BASE_ENV,
      PULSERUN_NETWORK: 'local',
      STELLAR_RPC_URL: 'http://localhost:9000',
      PULSERUN_POLL_INTERVAL_MS: '1500',
      PULSERUN_CPU_LIMIT: '2.5',
      PULSERUN_MEMORY_LIMIT_MB: '512',
      PULSERUN_ALLOW_NETWORK: 'yes',
      PULSERUN_JOB_TIMEOUT_SECONDS: '60',
      PULSERUN_MAX_CONCURRENCY: '4',
      PULSERUN_AUTO_CLAIM: 'off',
      PULSERUN_JOB_SPECS_FILE: '/tmp/specs.json',
      PULSERUN_LOG_LEVEL: 'DEBUG',
    });

    expect(config.network).toBe('local');
    expect(config.rpcUrl).toBe('http://localhost:9000');
    expect(config.pollIntervalMs).toBe(1500);
    expect(config.cpuLimit).toBe(2.5);
    expect(config.memoryLimitMb).toBe(512);
    expect(config.allowNetwork).toBe(true);
    expect(config.jobTimeoutSeconds).toBe(60);
    expect(config.maxConcurrency).toBe(4);
    expect(config.autoClaimPayout).toBe(false);
    expect(config.jobSpecsFile).toBe('/tmp/specs.json');
    expect(config.logLevel).toBe('debug');
  });

  it('applies overrides on top of the environment', () => {
    expect(loadConfig(BASE_ENV, { once: true }).once).toBe(true);
  });

  it('requires the contract id and secret key', () => {
    expect(() => loadConfig({ PULSERUN_SECRET_KEY: SECRET })).toThrowError(
      /PULSEESCROW_ID is required/,
    );
    expect(() => loadConfig({ PULSEESCROW_ID: CONTRACT_ID })).toThrowError(
      /PULSERUN_SECRET_KEY is required/,
    );
  });

  it('rejects a malformed secret key', () => {
    expect(() =>
      loadConfig({ PULSEESCROW_ID: CONTRACT_ID, PULSERUN_SECRET_KEY: 'not-a-secret' }),
    ).toThrowError(/not a valid Stellar secret key/);
  });

  it('rejects out-of-range numbers', () => {
    expect(() => loadConfig({ ...BASE_ENV, PULSERUN_MEMORY_LIMIT_MB: '4' })).toThrowError(
      /PULSERUN_MEMORY_LIMIT_MB must be a number >= 16/,
    );
    expect(() => loadConfig({ ...BASE_ENV, PULSERUN_CPU_LIMIT: '0' })).toThrowError(
      /PULSERUN_CPU_LIMIT must be a number >= 0.1/,
    );
    expect(() => loadConfig({ ...BASE_ENV, PULSERUN_POLL_INTERVAL_MS: 'whoops' })).toThrowError(
      /must be a number/,
    );
  });

  it('rejects malformed booleans and log levels', () => {
    expect(() => loadConfig({ ...BASE_ENV, PULSERUN_ALLOW_NETWORK: 'maybe' })).toThrowError(
      /must be a boolean/,
    );
    expect(() => loadConfig({ ...BASE_ENV, PULSERUN_LOG_LEVEL: 'verbose' })).toThrowError(
      /PULSERUN_LOG_LEVEL must be one of/,
    );
  });
});

describe('dockerOptionsFromHost', () => {
  it('parses unix sockets', () => {
    expect(dockerOptionsFromHost('unix:///var/run/docker.sock')).toEqual({
      socketPath: '/var/run/docker.sock',
    });
  });

  it('parses tcp endpoints with sensible default ports', () => {
    expect(dockerOptionsFromHost('tcp://127.0.0.1:2375')).toEqual({
      host: '127.0.0.1',
      port: 2375,
      protocol: 'http',
    });
    expect(dockerOptionsFromHost('tcp://10.0.0.5')).toEqual({
      host: '10.0.0.5',
      port: 2375,
      protocol: 'http',
    });
    expect(dockerOptionsFromHost('https://docker.example.com')).toEqual({
      host: 'docker.example.com',
      port: 2376,
      protocol: 'https',
    });
  });

  it('parses Windows named pipes', () => {
    expect(dockerOptionsFromHost('npipe:////./pipe/docker_engine')).toEqual({
      socketPath: '//./pipe/docker_engine',
    });
  });

  it('rejects unknown schemes', () => {
    expect(() => dockerOptionsFromHost('ftp://docker')).toThrowError(/is invalid/);
  });
});

describe('createLogger', () => {
  it('filters by level and splits stdout/stderr', () => {
    const out = collect();
    const err = collect();
    const logger = createLogger({
      level: 'warn',
      timestamps: false,
      stdout: out.stream,
      stderr: err.stream,
    });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(out.lines()).toEqual([]);
    expect(err.lines()).toEqual(['WARN  w', 'ERROR e']);
  });

  it('emits debug output when the level allows it', () => {
    const out = collect();
    const logger = createLogger({ level: 'debug', timestamps: false, stdout: out.stream });
    logger.debug('boom');
    expect(out.lines()).toEqual(['DEBUG boom']);
  });

  it('exposes a silent logger', () => {
    expect(() => {
      silentLogger.debug('x');
      silentLogger.info('x');
      silentLogger.warn('x');
      silentLogger.error('x');
    }).not.toThrow();
  });
});
