#!/usr/bin/env node
/**
 * `pulserun` CLI entrypoint.
 *
 * Wires the `run` and `status` subcommands together and maps thrown errors to
 * a friendly message plus a non-zero exit code.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { PulseRunError } from './client/soroban.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerRunCommand } from './commands/run.js';
import { registerStatusCommand } from './commands/status.js';
import { createLogger } from './ui.js';

/** Version reported by `pulserun --version`. Keep in sync with package.json. */
export const CLI_VERSION = '0.1.0';

/** Builds the commander program without parsing anything. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('pulserun')
    .description('Submit and inspect verifiable compute jobs on the PulseRun escrow contract.')
    .version(CLI_VERSION, '-v, --version', 'print the CLI version')
    .showHelpAfterError('(run `pulserun <command> --help` for usage)')
    // Throw instead of calling process.exit so `main` owns the exit code and
    // the CLI stays embeddable (and testable).
    .exitOverride();

  registerRunCommand(program);
  registerStatusCommand(program);
  registerLifecycleCommands(program);

  return program;
}

/** Formats any thrown value for the terminal. */
export function formatError(error: unknown): string {
  if (error instanceof PulseRunError) return `pulserun: ${error.message}`;
  if (error instanceof Error) return `pulserun: ${error.message}`;
  return `pulserun: ${String(error)}`;
}

/**
 * Parses `argv` and runs the selected command.
 *
 * @returns the process exit code: `0` on success, `1` on any failure. Commands
 *   may lower the bar by setting `process.exitCode` themselves (for example
 *   `run` fails when the job did not complete).
 */
export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync([...argv]);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof Error && error.name === 'CommanderError') {
      // commander already printed usage; mirror its exit code.
      const code = (error as { exitCode?: number }).exitCode;
      return typeof code === 'number' ? code : 1;
    }
    createLogger().error(formatError(error));
    return 1;
  }
}

/** True when this module is the process entrypoint (follows `bin` symlinks). */
export function isDirectExecution(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
