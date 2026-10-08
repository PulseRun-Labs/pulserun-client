/**
 * Escrow lifecycle commands.
 *
 * `claim` settles a completed job once the dispute window has elapsed;
 * `dispute` lets the requester challenge a proof inside that window; `cancel`
 * refunds a job the runner never proved. All three map one-to-one onto
 * `PulseEscrow` entrypoints.
 */

import { type Command } from 'commander';
import { PulseRunClient, formatTokenAmount, toJobId } from '../client/soroban.js';
import { parseDecimals, resolveConnection, resolveSecretKey } from '../config.js';
import { createLogger, type Logger } from '../ui.js';
import { emitJson } from './run.js';

export interface LifecycleOptions {
  key?: string;
  network?: string;
  rpcUrl?: string;
  contract?: string;
  decimals?: string;
  json?: boolean;
}

export interface LifecycleDependencies {
  logger?: Logger;
  client?: PulseRunClient;
  stdout?: NodeJS.WritableStream;
}

interface LifecycleContext {
  client: PulseRunClient;
  logger: Logger;
  stdout: NodeJS.WritableStream;
  decimals: number;
  jobId: bigint;
  json: boolean;
}

function buildContext(
  jobId: string | number | bigint,
  options: LifecycleOptions,
  deps: LifecycleDependencies,
): LifecycleContext {
  const client =
    deps.client ??
    (() => {
      const endpoints = resolveConnection(options);
      return PulseRunClient.fromSecretKey(resolveSecretKey(options), {
        rpcUrl: endpoints.rpcUrl,
        networkPassphrase: endpoints.networkPassphrase,
        contractId: endpoints.contractId,
      });
    })();

  return {
    client,
    logger: deps.logger ?? createLogger(),
    stdout: deps.stdout ?? process.stdout,
    decimals: parseDecimals(options.decimals),
    jobId: toJobId(jobId),
    json: Boolean(options.json),
  };
}

/** Settles a completed job, paying the runner. */
export async function claimCommand(
  jobId: string | number | bigint,
  options: LifecycleOptions = {},
  deps: LifecycleDependencies = {},
): Promise<{ earnings: bigint; txHash: string; ledger: number }> {
  const ctx = buildContext(jobId, options, deps);
  const result = await ctx.client.claimPayout(ctx.jobId);

  if (ctx.json) {
    emitJson(ctx.stdout, {
      jobId: ctx.jobId.toString(),
      earnings: result.earnings.toString(),
      earningsTokens: formatTokenAmount(result.earnings, ctx.decimals),
      txHash: result.txHash,
      ledger: result.ledger,
    });
  } else {
    ctx.logger.success(
      `Job #${ctx.jobId} settled: runner paid ${formatTokenAmount(result.earnings, ctx.decimals)} ` +
        `(tx ${result.txHash}, ledger ${result.ledger}).`,
    );
  }
  return result;
}

/** Challenges a completed proof inside the dispute window. */
export async function disputeCommand(
  jobId: string | number | bigint,
  options: LifecycleOptions = {},
  deps: LifecycleDependencies = {},
): Promise<{ txHash: string; ledger: number }> {
  const ctx = buildContext(jobId, options, deps);
  const result = await ctx.client.disputeJob(ctx.jobId);

  if (ctx.json) {
    emitJson(ctx.stdout, {
      jobId: ctx.jobId.toString(),
      status: 'Disputed',
      txHash: result.txHash,
      ledger: result.ledger,
    });
  } else {
    ctx.logger.warn(
      `Job #${ctx.jobId} disputed: payout is frozen (tx ${result.txHash}, ledger ${result.ledger}).`,
    );
  }
  return result;
}

/** Refunds a queued job the runner never proved. */
export async function cancelCommand(
  jobId: string | number | bigint,
  options: LifecycleOptions = {},
  deps: LifecycleDependencies = {},
): Promise<{ txHash: string; ledger: number }> {
  const ctx = buildContext(jobId, options, deps);
  const result = await ctx.client.cancelUnclaimedJob(ctx.jobId);

  if (ctx.json) {
    emitJson(ctx.stdout, {
      jobId: ctx.jobId.toString(),
      status: 'Refunded',
      txHash: result.txHash,
      ledger: result.ledger,
    });
  } else {
    ctx.logger.success(
      `Job #${ctx.jobId} refunded to the requester (tx ${result.txHash}, ledger ${result.ledger}).`,
    );
  }
  return result;
}

function attachCommonOptions(command: Command): Command {
  return command
    .argument('<job_id>', 'on-chain job id')
    .option('--key <secret>', 'Stellar secret key (S...) used to sign the call')
    .option('--network <name>', 'testnet | futurenet | mainnet | local')
    .option('--rpc-url <url>', 'Soroban RPC endpoint override')
    .option('--contract <id>', 'PulseEscrow contract ID (C...)')
    .option('--decimals <n>', 'payment token decimal precision', '7')
    .option('--json', 'emit machine-readable JSON');
}

/** Registers `claim`, `dispute` and `cancel` on the root program. */
export function registerLifecycleCommands(program: Command): void {
  attachCommonOptions(
    program
      .command('claim')
      .description('Settle a completed job and pay the runner (after the dispute window).'),
  ).action(async (rawJobId: string, options: LifecycleOptions) => {
    await claimCommand(rawJobId, options);
  });

  attachCommonOptions(
    program
      .command('dispute')
      .description('Challenge a completed proof inside the dispute window.'),
  ).action(async (rawJobId: string, options: LifecycleOptions) => {
    await disputeCommand(rawJobId, options);
  });

  attachCommonOptions(
    program
      .command('cancel')
      .description('Refund a queued job the runner never proved (after max duration).'),
  ).action(async (rawJobId: string, options: LifecycleOptions) => {
    await cancelCommand(rawJobId, options);
  });
}
