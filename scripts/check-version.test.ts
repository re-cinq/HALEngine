import {mkdtempSync, copyFileSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {root} from './lib/repo-root.mjs';
import {runBash} from './helpers/script-runner.js';

// A tag that has fired a publish cannot be un-pushed, so everything here runs before the tag exists.

const script = join(root, 'scripts', 'check-version.sh');
const workspaces: string[] = [];

// The script resolves its repository from its own location, so a fixture has to hold a copy of it.
const workspace = (version: string, changelog: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'check-version-'));
  workspaces.push(dir);

  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'check-version.sh'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: '@scope/fixture', version}));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);

  return dir;
};

const run = (dir: string, tag: string) => runBash(join(dir, 'scripts', 'check-version.sh'), [tag], {cwd: dir});

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, {recursive: true, force: true});
});

describe('check-version', () => {
  it('accepts a tag that matches the version under a changelog heading naming it', () => {
    expect(run(workspace('0.2.0', '## [0.2.0] - 2026-09-12\n'), 'v0.2.0')).toMatchObject({status: 0});
  });

  it('refuses a tag that disagrees with the committed version', () => {
    expect(run(workspace('0.2.0', '## [0.2.0]\n'), 'v9.9.9')).toMatchObject({status: 1});
  });

  it('refuses a prerelease tag, because nothing here passes a dist-tag', () => {
    expect(run(workspace('0.2.0', '## [0.2.0]\n'), 'v0.2.0-rc.1')).toMatchObject({status: 1});
  });

  // check-changelog.sh only asks that the file was touched, so the release rename was ungated.
  it('refuses a version the changelog never names', () => {
    expect(run(workspace('0.2.0', '## [Unreleased]\n'), 'v0.2.0')).toMatchObject({status: 1});
  });

  it('says which heading is missing rather than only that something is wrong', () => {
    expect(run(workspace('0.2.0', '## [Unreleased]\n'), 'v0.2.0').stderr).toContain("no '## [0.2.0]' heading");
  });

  // A dot is a regex metacharacter, so 0.2.0 must not match a heading reading 0x2x0.
  it('does not accept a heading that merely matches the version as a pattern', () => {
    expect(run(workspace('0.2.0', '## [0x2x0]\n'), 'v0.2.0')).toMatchObject({status: 1});
  });

  it('accepts a heading carrying no date, which Keep a Changelog allows', () => {
    expect(run(workspace('1.0.0', '## [Unreleased]\n\n## [1.0.0]\n'), 'v1.0.0')).toMatchObject({status: 0});
  });
});
