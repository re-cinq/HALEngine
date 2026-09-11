import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {root} from './lib/repo-root.mjs';

// A tag is a mutable pointer, and these workflows run with repository credentials.

const fixtures = 'scripts/fixtures/action-pins';
const script = join(root, 'scripts', 'check-action-pins.sh');

// A shell script, so it is spawned through bash rather than the shared node runner.
const run = (dir: string) => {
  const result = spawnSync('bash', [script, dir], {cwd: root, encoding: 'utf8'});
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

  // A composite action carries its own `uses:` lines and the workflows-only scan never saw them.
  it('refuses an unpinned reference inside a composite action, not just a workflow', () => {
    expect(run(`${fixtures}/composite`)).toMatchObject({status: 1});
  });

  it('would have passed that composite under a workflows-only scan, which is why the scope widened', () => {
    expect(run(`${fixtures}/composite/workflows`)).toMatchObject({status: 0});
  });
});
