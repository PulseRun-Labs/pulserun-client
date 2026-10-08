import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/config.js';
import {
  type ContainerCreateSpec,
  type ContainerHandle,
  type ContainerRuntime,
  DockerExecutor,
} from '../src/executor.js';
import { TIMEOUT_EXIT_CODE } from '../src/proof.js';

function createLoggerSpy() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Logger;
}

interface FakeHandleOptions {
  statusCode?: number;
  logs?: string;
  exitCode?: number;
  oomKilled?: boolean;
  /** When true, `wait()` only settles after `kill()`. */
  waitUntilKilled?: boolean;
  onKill?: () => void;
  removeError?: Error;
  logsError?: Error;
}

function createFakeHandle(options: FakeHandleOptions = {}) {
  let release: (value: { statusCode: number }) => void = () => {};
  let settled = false;

  const wait = vi.fn(async () => {
    if (!options.waitUntilKilled) {
      settled = true;
      return { statusCode: options.statusCode ?? 0 };
    }
    if (!settled) {
      await new Promise<{ statusCode: number }>((resolve) => {
        release = (value) => {
          settled = true;
          resolve(value);
        };
      });
    }
    return { statusCode: options.statusCode ?? 137 };
  });

  const kill = vi.fn(async () => {
    options.onKill?.();
    release({ statusCode: options.statusCode ?? 137 });
  });

  const remove = vi.fn(async () => {
    if (options.removeError) throw options.removeError;
  });

  const logs = vi.fn(async () => {
    if (options.logsError) throw options.logsError;
    return Buffer.from(options.logs ?? 'hello from the sandbox', 'utf8');
  });

  const inspect = vi.fn(async () => ({
    exitCode: options.exitCode ?? options.statusCode ?? 0,
    oomKilled: options.oomKilled ?? false,
  }));

  const handle: ContainerHandle = {
    id: 'container-abcdef123456',
    wait,
    kill,
    remove,
    logs,
    inspect,
  };
  return { handle, wait, kill, remove, logs, inspect };
}

function createRuntime(handle: ContainerHandle) {
  const create = vi.fn(async (_spec: ContainerCreateSpec) => handle);
  const runtime: ContainerRuntime = { pullImage: vi.fn(async () => {}), create };
  return { runtime, pullImage: runtime.pullImage as ReturnType<typeof vi.fn>, create };
}

const LIMITS = {
  cpuLimit: 1,
  memoryLimitMb: 512,
  pidsLimit: 128,
  allowNetwork: false,
};

function createExecutor(runtime: ContainerRuntime, logger: Logger = createLoggerSpy()) {
  return new DockerExecutor({ runtime, limits: LIMITS, logger });
}

describe('DockerExecutor.execute', () => {
  it('pulls the image, applies limits and returns logs plus the exit code', async () => {
    const { handle, remove } = createFakeHandle({ statusCode: 0, logs: 'ok\n' });
    const { runtime, pullImage, create } = createRuntime(handle);
    const logger = createLoggerSpy();

    const result = await createExecutor(runtime, logger).execute({
      jobId: 7n,
      image: 'node:22-alpine',
      command: 'pnpm test',
      timeoutSeconds: 60,
    });

    expect(result).toMatchObject({ jobId: 7n, exitCode: 0, logs: 'ok\n', timedOut: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(pullImage).toHaveBeenCalledWith('node:22-alpine');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'node:22-alpine',
        command: 'pnpm test',
        cpuLimit: 1,
        memoryLimitMb: 512,
        pidsLimit: 128,
        allowNetwork: false,
        name: 'pulserun-job-7',
        labels: { 'pulserun.job-id': '7', 'pulserun.image': 'node:22-alpine' },
      }),
    );
    expect(remove).toHaveBeenCalledOnce();
  });

  it('reports a non-zero exit code', async () => {
    const { handle } = createFakeHandle({ statusCode: 2, exitCode: 2, logs: 'failures' });
    const { runtime } = createRuntime(handle);

    const result = await createExecutor(runtime).execute({
      jobId: 1n,
      image: 'alpine',
      command: 'false',
      timeoutSeconds: 60,
    });

    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  it('kills the sandbox and reports the timeout exit code when the deadline passes', async () => {
    const { handle, kill } = createFakeHandle({ waitUntilKilled: true, exitCode: 137 });
    const { runtime } = createRuntime(handle);

    const result = await createExecutor(runtime).execute({
      jobId: 3n,
      image: 'alpine',
      command: 'sleep 999',
      timeoutSeconds: 1,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(kill).toHaveBeenCalledOnce();
  }, 10_000);

  it('always removes the container, even when log capture fails', async () => {
    const { handle, remove } = createFakeHandle({ logsError: new Error('no logs') });
    const { runtime } = createRuntime(handle);

    const result = await createExecutor(runtime).execute({
      jobId: 4n,
      image: 'alpine',
      command: 'true',
      timeoutSeconds: 60,
    });

    expect(result.logs).toBe('');
    expect(remove).toHaveBeenCalledOnce();
  });

  it('warns but does not fail when cleanup fails', async () => {
    const { handle } = createFakeHandle({ removeError: new Error('docker is down') });
    const { runtime } = createRuntime(handle);
    const logger = createLoggerSpy();

    const result = await createExecutor(runtime, logger).execute({
      jobId: 5n,
      image: 'alpine',
      command: 'true',
      timeoutSeconds: 60,
    });

    expect(result.exitCode).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to remove container'));
  });

  it('surfaces OOM kills', async () => {
    const { handle } = createFakeHandle({ exitCode: 137, oomKilled: true });
    const { runtime } = createRuntime(handle);
    const logger = createLoggerSpy();

    const result = await createExecutor(runtime, logger).execute({
      jobId: 6n,
      image: 'alpine',
      command: 'stress',
      timeoutSeconds: 60,
    });

    expect(result.oomKilled).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('OOM-killed'));
  });

  it('rejects malformed jobs before touching Docker', async () => {
    const { handle } = createFakeHandle();
    const { runtime, pullImage } = createRuntime(handle);
    const executor = createExecutor(runtime);

    await expect(
      executor.execute({ jobId: 1n, image: '  ', command: 'ls', timeoutSeconds: 10 }),
    ).rejects.toThrowError(/has no image/);
    await expect(
      executor.execute({ jobId: 1n, image: 'alpine', command: '', timeoutSeconds: 10 }),
    ).rejects.toThrowError(/has no command/);
    expect(pullImage).not.toHaveBeenCalled();
  });
});
