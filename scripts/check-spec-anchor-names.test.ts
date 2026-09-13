import {copyFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {scriptRunner} from './helpers/script-runner.js';

// A citation's line is derived; its name is what the author meant. These drive the real script.

const fixtures = 'scripts/fixtures/anchor-names/specs/sample';
const {run} = scriptRunner(join(process.cwd(), 'scripts', 'check-spec-anchor-names.mjs'));

const spec = (name: string) => `${fixtures}/${name}.md`;

// --fix rewrites its input, so a case that repairs works on a copy and restores it afterwards.
const onACopy = (name: string, act: (path: string) => void): string => {
  const original = join(process.cwd(), spec(name));
  const backup = `${original}.backup`;
  copyFileSync(original, backup);
  try {
    act(spec(name));
    return readFileSync(original, 'utf8');
  } finally {
    copyFileSync(backup, original);
    rmSync(backup);
  }
};

describe('check-spec-anchor-names', () => {
  it('accepts a citation whose name matches the declaration it points at', () => {
    expect(run(spec('named'))).toMatchObject({status: 0});
  });

  it('reports a citation whose line has moved away from the test it names', () => {
    expect(run(spec('drifted'))).toMatchObject({status: 1});
  });

  it('names the line the cited test actually sits on, so the repair is obvious', () => {
    expect(run(spec('drifted')).stderr).toContain('points at #L2; it is at #L6');
  });

  it('reports a citation carrying no test name at all', () => {
    expect(run(spec('unnamed')).stderr).toContain('carries no test name');
  });

  it('reports a name no declaration in the cited file has', () => {
    expect(run(spec('absent')).stderr).toContain('which no declaration in');
  });

  it('repoints a drifted citation from the name it carries', () => {
    const after = onACopy('drifted', path => run(path, '--fix'));

    expect(after).toContain('#L6)');
  });

  it('fills in a missing name from the declaration the line points at', () => {
    const after = onACopy('unnamed', path => run(path, '--fix'));

    expect(after).toContain('[validated by: does the first thing]');
  });

  it('leaves a citation that already agrees with its declaration untouched', () => {
    const before = readFileSync(join(process.cwd(), spec('named')), 'utf8');
    const after = onACopy('named', path => run(path, '--fix'));

    expect(after).toBe(before);
  });

  it('reports a name that two declarations share, rather than choosing between them', () => {
    expect(run(spec('ambiguous')).stderr).toContain('names 2 declarations');
  });

  it('refuses to rewrite an ambiguous citation', () => {
    const before = readFileSync(join(process.cwd(), spec('ambiguous')), 'utf8');
    const after = onACopy('ambiguous', path => run(path, '--fix'));

    expect(after).toBe(before);
  });

  it('refuses to write a name that would break the markdown label', () => {
    const before = readFileSync(join(process.cwd(), spec('bracket')), 'utf8');
    const after = onACopy('bracket', path => run(path, '--fix'));

    expect(after).toBe(before);
  });

  it('reports a citation of a test declared with xit, which never runs', () => {
    expect(run(spec('skipped')).stderr).toContain('which is skipped and validates nothing');
  });

  it('reports a citation of a test declared with .skip the same way', () => {
    expect(run(spec('skipped-dot'))).toMatchObject({status: 1});
  });

  it('reports a root-relative href, which the drift check would never read', () => {
    expect(run(spec('rooted')).stderr).toContain('must be relative and start with ../');
  });

  it('reports an href starting ./, which this gate would otherwise have skipped', () => {
    expect(run(spec('dotted'))).toMatchObject({status: 1});
  });
});
