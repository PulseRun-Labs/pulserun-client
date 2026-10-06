/**
 * Small presentation helpers shared by the CLI commands.
 *
 * Everything here is deliberately dependency free so the CLI can stay a thin
 * wrapper around the Soroban client: colour is opt-in (TTY / `FORCE_COLOR`)
 * and can always be turned off with `NO_COLOR`, which keeps CI logs readable.
 */

const ANSI = {
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const;

export type ColorName = keyof typeof ANSI;

const ANSI_RESET = '\u001b[0m';

/** Wraps `text` in an ANSI colour when `enabled` is true. */
export function colorize(text: string, color: ColorName, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${ANSI_RESET}` : text;
}

export interface ColorCapableStream {
  isTTY?: boolean;
}

/**
 * Decides whether ANSI output should be emitted.
 *
 * `NO_COLOR` always wins, `FORCE_COLOR` forces colour on, and otherwise we
 * only colourise when writing to a TTY.
 */
export function shouldUseColor(
  stream: ColorCapableStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(stream.isTTY);
}

export interface Logger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  color?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Writes a line to `stream`, swallowing EPIPE (e.g. `pulserun run | head`). */
function writeLine(stream: NodeJS.WritableStream, line: string): void {
  try {
    stream.write(`${line}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const color = options.color ?? shouldUseColor();

  return {
    info: (message) => writeLine(stdout, message),
    success: (message) => writeLine(stdout, colorize(message, 'green', color)),
    warn: (message) => writeLine(stderr, colorize(message, 'yellow', color)),
    error: (message) => writeLine(stderr, colorize(message, 'red', color)),
  };
}

/** A logger that discards everything; handy for `--json` mode and tests. */
export const silentLogger: Logger = {
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Formats a whole number of seconds as `1h 05m`, `12m 30s` or `45s`.
 * Negative inputs keep their sign so callers can show overdue deadlines.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return 'unknown';
  const sign = totalSeconds < 0 ? '-' : '';
  const seconds = Math.abs(Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) return `${sign}${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${sign}${minutes}m ${String(remainder).padStart(2, '0')}s`;
  return `${sign}${remainder}s`;
}

/** Shortens a Stellar address for display: `GABC…WXYZ`. */
export function shortenAddress(address: string, edge = 6): string {
  if (address.length <= edge * 2 + 1) return address;
  return `${address.slice(0, edge)}…${address.slice(-edge)}`;
}

/** Formats a unix timestamp (seconds) as an ISO-8601 string. */
export function formatTimestamp(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return 'unknown';
  return new Date(unixSeconds * 1000).toISOString();
}

/** Renders a byte array (or hex string) as a `0x…` hex string. */
export function bytesToHex(value: Uint8Array | string): string {
  if (typeof value === 'string') {
    return value.startsWith('0x') ? value : `0x${value}`;
  }
  return `0x${Buffer.from(value).toString('hex')}`;
}
