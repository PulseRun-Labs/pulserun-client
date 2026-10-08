import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonError } from '../src/config.js';
import { FileJobSpecStore } from '../src/specs.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulserun-specs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSpecs(content: string): Promise<string> {
  const path = join(dir, 'specs.json');
  await writeFile(path, content, 'utf8');
  return path;
}

describe('FileJobSpecStore', () => {
  it('returns null when the file does not exist yet', async () => {
    const store = new FileJobSpecStore({ path: join(dir, 'missing.json') });
    await expect(store.get(7n)).resolves.toBeNull();
  });

  it('returns null when the job has no spec', async () => {
    const path = await writeSpecs(JSON.stringify({ '8': { image: 'alpine', command: 'true' } }));
    const store = new FileJobSpecStore({ path });
    await expect(store.get(7n)).resolves.toBeNull();
  });

  it('returns a trimmed spec for the job', async () => {
    const path = await writeSpecs(
      JSON.stringify({ '7': { image: '  node:22-alpine ', command: ' pnpm test ' } }),
    );
    const store = new FileJobSpecStore({ path });
    await expect(store.get(7n)).resolves.toEqual({
      image: 'node:22-alpine',
      command: 'pnpm test',
    });
  });

  it('rejects invalid JSON and non-object roots', async () => {
    const badJson = await writeSpecs('{not json');
    await expect(new FileJobSpecStore({ path: badJson }).get(7n)).rejects.toThrowError(
      /not valid JSON/,
    );

    const arrayRoot = await writeSpecs('[]');
    await expect(new FileJobSpecStore({ path: arrayRoot }).get(7n)).rejects.toThrowError(
      /must contain a JSON object/,
    );
  });

  it('rejects an entry missing image or command', async () => {
    const missingImage = await writeSpecs(JSON.stringify({ '7': { command: 'true' } }));
    await expect(new FileJobSpecStore({ path: missingImage }).get(7n)).rejects.toThrowError(
      /non-empty "image"/,
    );

    const missingCommand = await writeSpecs(JSON.stringify({ '7': { image: 'alpine' } }));
    await expect(new FileJobSpecStore({ path: missingCommand }).get(7n)).rejects.toThrowError(
      DaemonError,
    );
  });
});
