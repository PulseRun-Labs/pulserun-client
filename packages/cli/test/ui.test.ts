import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  colorize,
  createLogger,
  formatDuration,
  formatTimestamp,
  shortenAddress,
  shouldUseColor,
} from '../src/ui.js';

function collect(): { stream: NodeJS.WritableStream; lines: () => string[] } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    lines: () => chunks.join('').trimEnd().split('\n'),
  };
}

describe('shouldUseColor', () => {
  it('honours NO_COLOR above everything else', () => {
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false);
  });

  it('honours FORCE_COLOR', () => {
    expect(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(shouldUseColor({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(true);
  });

  it('falls back to TTY detection', () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
  });
});

describe('colorize', () => {
  it('wraps text when enabled and passes it through when not', () => {
    expect(colorize('ok', 'green', true)).toBe('\u001b[32mok\u001b[0m');
    expect(colorize('ok', 'green', false)).toBe('ok');
  });
});

describe('createLogger', () => {
  it('routes info to stdout and errors to stderr', () => {
    const out = collect();
    const err = collect();
    const logger = createLogger({ color: false, stdout: out.stream, stderr: err.stream });

    logger.info('hello');
    logger.success('done');
    logger.warn('careful');
    logger.error('boom');

    expect(out.lines()).toEqual(['hello', 'done']);
    expect(err.lines()).toEqual(['careful', 'boom']);
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3900)).toBe('1h 05m');
  });

  it('keeps negative durations signed', () => {
    expect(formatDuration(-30)).toBe('-30s');
  });

  it('handles non-finite input', () => {
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });
});

describe('shortenAddress', () => {
  it('shortens long addresses', () => {
    expect(shortenAddress('G'.repeat(56))).toBe('GGGGGG…GGGGGG');
  });

  it('leaves short addresses alone', () => {
    expect(shortenAddress('GSHORT')).toBe('GSHORT');
  });
});

describe('formatTimestamp', () => {
  it('renders ISO-8601', () => {
    expect(formatTimestamp(0)).toBe('unknown');
    expect(formatTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('bytesToHex', () => {
  it('normalises byte arrays and hex strings', () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad]))).toBe('0xdead');
    expect(bytesToHex('dead')).toBe('0xdead');
    expect(bytesToHex('0xdead')).toBe('0xdead');
  });
});
