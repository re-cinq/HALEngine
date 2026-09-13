import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {root} from './lib/repo-root.mjs';

// A tag is a mutable pointer, and these workflows run with repository credentials.

const fixtures = 'scripts/fixtures/action-pins';
const script = join(root, 'scripts', 'check-action-pins.mjs');

const run = (dir: string) => {
  const result = spawnSync(process.execPath, [script, dir], {cwd: root, encoding: 'utf8'});
  return {status: result.status, stdout: result.stdout, stderr: result.stderr};
};

describe('check-action-pins', () => {
  it('accepts a reference pinned to a 40-hex commit SHA', () => {
    expect(run(`${fixtures}/pinned`)).toMatchObject({status: 0});
  });

  it('refuses a reference pinned to a tag', () => {
    expect(run(`${fixtures}/unpinned`)).toMatchObject({status: 1});
  });

  it('names the file, the line and the reference it refused', () => {
    expect(run(`${fixtures}/unpinned`).stderr).toContain('ci.yml:7 pins "actions/checkout@v4"');
  });

  it('skips a local reference, which cannot be pinned to a SHA', () => {
    expect(run(`${fixtures}/pinned`).stdout).toContain('every uses: reference is SHA-pinned');
  });

  // Flow style is the same document written differently, and a line scan read only one of the two.
  it('refuses an unpinned reference written in YAML flow style', () => {
    expect(run(`${fixtures}/flow`)).toMatchObject({status: 1});
  });

  it('names the reference it found in flow style, which no line grep could reach', () => {
    expect(run(`${fixtures}/flow`).stderr).toContain('ci.yml:6 pins "actions/checkout@v4"');
  });

  // A composite action carries its own `uses:` lines and the workflows-only scan never saw them.
  it('refuses an unpinned reference inside a composite action, not just a workflow', () => {
    expect(run(`${fixtures}/composite`)).toMatchObject({status: 1});
  });

  it('would have passed that composite under a workflows-only scan, which is why the scope widened', () => {
    expect(run(`${fixtures}/composite/workflows`)).toMatchObject({status: 0});
  });
});
