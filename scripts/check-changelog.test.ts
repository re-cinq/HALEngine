import {copyFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root} from './lib/repo-root.mjs';
import {git, runBash, writeInRepo as write} from './helpers/script-runner.js';

// The gate compares a branch against a base ref, so each case needs a repository that has both.

const script = join(root, 'scripts', 'check-changelog.sh');
const workspaces: string[] = [];

const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'check-changelog-'));
  workspaces.push(dir);

  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'scripts'), {recursive: true});
  copyFileSync(script, join(dir, 'scripts', 'check-changelog.sh'));
  write(dir, 'src/index.ts', 'export const a = 1;\n');
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'branch', 'base-ref');

  return dir;
};

const commit = (dir: string, files: Record<string, string>): void => {
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'change');
};

// GITHUB_ACTIONS is set explicitly rather than inherited: the suite itself runs under it in CI.
const runWith = (dir: string, base: string, githubActions: string) =>
  runBash(join(dir, 'scripts', 'check-changelog.sh'), [base], {cwd: dir, env: {GITHUB_ACTIONS: githubActions}});

const run = (dir: string, base: string) => runWith(dir, base, '');
const runInCi = (dir: string, base: string) => runWith(dir, base, 'true');

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, {recursive: true, force: true});
});

describe('check-changelog', () => {
  it('accepts a change to shipped source that updates the changelog', () => {
    const dir = workspace();
    commit(dir, {'src/index.ts': 'export const a = 2;\n', 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n- a\n'});

    expect(run(dir, 'base-ref')).toMatchObject({status: 0});
  });

  it('refuses a change to shipped source that leaves the changelog alone', () => {
    const dir = workspace();
    commit(dir, {'src/index.ts': 'export const a = 2;\n'});

    expect(run(dir, 'base-ref')).toMatchObject({status: 1});
  });

  it('names the file that changed, so the report says what to write about', () => {
    const dir = workspace();
    commit(dir, {'src/index.ts': 'export const a = 2;\n'});

    expect(run(dir, 'base-ref').stderr).toContain('src/index.ts');
  });

  it('accepts a change to a test under src, which ships nothing a consumer observes', () => {
    const dir = workspace();
    commit(dir, {'src/index.test.ts': 'it("x", () => expect(1).toBe(1));\n'});

    expect(run(dir, 'base-ref')).toMatchObject({status: 0});
  });

  it('skips on a base ref that does not resolve, because a fresh clone has no remote branch', () => {
    expect(run(workspace(), 'no-such-ref')).toMatchObject({status: 0});
  });

  it('fails on an unresolvable base ref in CI, rather than passing a gate that never ran', () => {
    expect(runInCi(workspace(), 'no-such-ref')).toMatchObject({status: 1});
  });
});
