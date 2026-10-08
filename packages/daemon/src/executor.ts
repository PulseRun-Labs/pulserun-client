/**
 * Sandbox executor.
 *
 * Pulls the requested image and runs the job command in a container with hard
 * CPU, memory and PID limits. The container is never given the host's network
 * unless {@link ExecutorLimits.allowNetwork} is set, and it is always removed
 * after the run so runner disks do not fill up.
 *
 * Everything Docker-specific is behind {@link ContainerRuntime} so the
 * orchestration logic (timeouts, cleanup, log capture) is unit-testable.
 */

import Docker from 'dockerode';
import { DaemonError, type Logger, dockerOptionsFromHost, silentLogger } from './config.js';
import { TIMEOUT_EXIT_CODE } from './proof.js';

/** Resource limits applied to a single sandbox. */
export interface ExecutorLimits {
  /** CPU limit in cores; fractional values are floored to nanoseconds. */
  cpuLimit: number;
  /** Memory limit in mebibytes. */
  memoryLimitMb: number;
  /** Maximum number of processes inside the sandbox. */
  pidsLimit: number;
  /** When false, the sandbox runs with `NetworkMode: none`. */
  allowNetwork: boolean;
  /** Working directory inside the container. */
  workingDir?: string;
  /** Extra environment variables passed to the container. */
  env?: Record<string, string>;
}

export interface ExecutionRequest {
  jobId: bigint;
  image: string;
  command: string;
  /** Wall-clock budget in seconds; the sandbox is killed when exceeded. */
  timeoutSeconds: number;
}

export interface ExecutionResult {
  jobId: bigint;
  /** Container exit code, or {@link TIMEOUT_EXIT_CODE} when killed. */
  exitCode: number;
  /** Combined stdout/stderr, decoded as UTF-8. */
  logs: string;
  /** Wall-clock duration of the run, in milliseconds. */
  durationMs: number;
  timedOut: boolean;
  /** True when the container was killed by the OOM killer. */
  oomKilled: boolean;
}

// ---------------------------------------------------------------------------
// Runtime abstraction (thin wrapper over dockerode)
// ---------------------------------------------------------------------------

export interface ContainerCreateSpec extends ExecutorLimits {
  image: string;
  command: string;
  /** Labels attached to the container, e.g. the job id. */
  labels?: Record<string, string>;
  /** Container name; defaults to a PulseRun-generated one. */
  name?: string;
}

export interface ContainerHandle {
  id: string;
  wait(): Promise<{ statusCode: number }>;
  logs(options: { stdout: boolean; stderr: boolean }): Promise<Buffer>;
  inspect(): Promise<{ exitCode: number; oomKilled: boolean }>;
  kill(): Promise<void>;
  remove(): Promise<void>;
}

export interface ContainerRuntime {
  /** Pulls `image` when it is not already present locally. */
  pullImage(image: string): Promise<void>;
  /** Creates and starts a container according to `spec`. */
  create(spec: ContainerCreateSpec): Promise<ContainerHandle>;
}

/**
 * Minimal shape of dockerode's modem that we depend on; declared locally so
 * we do not have to reach into untyped `docker-modem` internals.
 */
interface DockerModemLike {
  followProgress(stream: NodeJS.ReadableStream, onFinished: (error: Error | null) => void): void;
}

/** Builds a {@link ContainerRuntime} backed by a real Docker daemon. */
export function createDockerRuntime(
  options: { dockerHost?: string; docker?: Docker } = {},
): ContainerRuntime {
  const docker =
    options.docker ??
    new Docker(options.dockerHost ? dockerOptionsFromHost(options.dockerHost) : undefined);
  const modem = (docker as unknown as { modem: DockerModemLike }).modem;

  return {
    async pullImage(image: string): Promise<void> {
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
      });
    },

    async create(spec: ContainerCreateSpec): Promise<ContainerHandle> {
      const memoryBytes = Math.max(1, Math.floor(spec.memoryLimitMb)) * 1024 * 1024;
      const container = await docker.createContainer({
        Image: spec.image,
        Cmd: ['sh', '-lc', spec.command],
        Labels: { 'pulserun.managed': 'true', ...spec.labels },
        ...(spec.name ? { name: spec.name } : {}),
        ...(spec.workingDir ? { WorkingDir: spec.workingDir } : {}),
        ...(spec.env && Object.keys(spec.env).length > 0 ? { Env: toEnvArray(spec.env) } : {}),
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          // Setting MemorySwap equal to Memory disables swap, so the limit is
          // a true ceiling instead of a hint.
          Memory: memoryBytes,
          MemorySwap: memoryBytes,
          NanoCpus: Math.max(1, Math.round(spec.cpuLimit * 1_000_000_000)),
          PidsLimit: Math.max(1, Math.floor(spec.pidsLimit)),
          NetworkMode: spec.allowNetwork ? 'bridge' : 'none',
          AutoRemove: false,
          Privileged: false,
        },
      });

      await container.start();

      return {
        id: container.id,
        async wait() {
          const result = (await container.wait()) as { StatusCode?: number };
          return { statusCode: result?.StatusCode ?? -1 };
        },
        async logs({ stdout, stderr }) {
          const output = await container.logs({ stdout, stderr, timestamps: false });
          return Buffer.isBuffer(output) ? output : Buffer.from(String(output));
        },
        async inspect() {
          const info = await container.inspect();
          return { exitCode: info.State.ExitCode, oomKilled: Boolean(info.State.OOMKilled) };
        },
        async kill() {
          await container.kill();
        },
        async remove() {
          await container.remove({ force: true, v: true });
        },
      };
    },
  };
}

function toEnvArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface DockerExecutorOptions {
  runtime: ContainerRuntime;
  limits: ExecutorLimits;
  logger?: Logger;
  /** Overrides `Date.now`, used by tests. */
  now?: () => number;
}

export class DockerExecutor {
  private readonly runtime: ContainerRuntime;
  private readonly limits: ExecutorLimits;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: DockerExecutorOptions) {
    this.runtime = options.runtime;
    this.limits = options.limits;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  /** Pulls, runs and cleans up a single sandbox. */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const image = request.image.trim();
    const command = request.command.trim();
    if (!image) throw new DaemonError(`Job #${request.jobId} has no image to execute.`);
    if (!command) throw new DaemonError(`Job #${request.jobId} has no command to execute.`);

    const startedAt = this.now();
    this.logger.info(`Job #${request.jobId}: pulling ${image}`);
    await this.runtime.pullImage(image);

    const handle = await this.runtime.create({
      ...this.limits,
      image,
      command,
      name: `pulserun-job-${request.jobId}`,
      labels: { 'pulserun.job-id': request.jobId.toString(), 'pulserun.image': image },
    });

    this.logger.info(
      `Job #${request.jobId}: running container ${handle.id.slice(0, 12)} ` +
        `(${this.limits.cpuLimit} cpu, ${this.limits.memoryLimitMb} MiB, timeout ${request.timeoutSeconds}s)`,
    );

    let timedOut = false;
    try {
      const outcome = await this.raceWithTimeout(handle, request.timeoutSeconds);
      timedOut = outcome.timedOut;
    } finally {
      // Never leak a sandbox, even when log capture or inspect throws.
      await handle.remove().catch((error: unknown) => {
        this.logger.warn(`Job #${request.jobId}: failed to remove container: ${describe(error)}`);
      });
    }

    const logs = (
      await handle.logs({ stdout: true, stderr: true }).catch(() => Buffer.alloc(0))
    ).toString('utf8');
    const state = await handle
      .inspect()
      .catch(() => ({ exitCode: timedOut ? TIMEOUT_EXIT_CODE : -1, oomKilled: false }));

    const exitCode = timedOut ? TIMEOUT_EXIT_CODE : state.exitCode;
    const durationMs = this.now() - startedAt;

    if (timedOut) {
      this.logger.warn(
        `Job #${request.jobId}: killed after ${request.timeoutSeconds}s (exit ${exitCode}).`,
      );
    } else if (state.oomKilled) {
      this.logger.warn(`Job #${request.jobId}: container was OOM-killed.`);
    } else {
      this.logger.info(
        `Job #${request.jobId}: finished with exit code ${exitCode} in ${durationMs}ms.`,
      );
    }

    return {
      jobId: request.jobId,
      exitCode,
      logs,
      durationMs,
      timedOut,
      oomKilled: state.oomKilled,
    };
  }

  /**
   * Waits for the container to exit, killing it when `timeoutSeconds` elapses.
   * The timer is unref'd so it never keeps the process alive on its own.
   */
  private async raceWithTimeout(
    handle: ContainerHandle,
    timeoutSeconds: number,
  ): Promise<{ timedOut: boolean }> {
    const waiting = handle.wait();
    // The wait promise is also awaited after a kill, so attach a no-op catch
    // immediately to avoid an unhandled rejection when it settles first.
    waiting.catch(() => {});

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(1, timeoutSeconds) * 1000);
      timer.unref?.();
    });

    try {
      const result = await Promise.race([waiting.then(() => 'exit' as const), timeout]);
      if (result === 'exit') return { timedOut: false };

      await handle.kill().catch((error: unknown) => {
        this.logger.warn(
          `Failed to kill timed-out container ${handle.id.slice(0, 12)}: ${describe(error)}`,
        );
      });
      await waiting.catch(() => {});
      return { timedOut: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
