import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// ts-jest erases a type-only import either way, so only the built package can show what a consumer loads.

const BUILD_MS = 180_000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const run = (command: string, args: string[]) =>
  execFileSync(command, args, {cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

describe('a consumer who installed no optional peer', () => {
  beforeAll(() => {
    if (existsSync(join(repoRoot, 'dist', 'index.js'))) return;
    run('npm', ['run', 'build']);
  }, BUILD_MS);

  // prettier-ignore
  it('can import the package root and use the in-memory store', () => {
    const probed = run('node', [
      '--import',
      './scripts/optional-peer-register.mjs',
      './scripts/optional-peer-probe.mjs',
    ]);

    expect(probed.trim()).toBe('OK');
  }, BUILD_MS);
});
