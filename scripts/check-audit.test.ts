import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The gate runs immediately before `npm publish`, so both of its red branches are the contract.

const script = join(process.cwd(), 'scripts', 'check-audit.mjs');

type RunResult = {status: number | null; stdout: string; stderr: string};

const workspaces: string[] = [];

// A stub `npm` on PATH: the script shells out, so this is the only seam that controls the report.
const workspace = (auditStdout: string, auditExit = 1): string => {
  const dir = mkdtempSync(join(tmpdir(), 'check-audit-'));
  workspaces.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin, {recursive: true});
  const stub = join(bin, 'npm');
  writeFileSync(stub, `#!/bin/sh\ncat <<'REPORT'\n${auditStdout}\nREPORT\nexit ${auditExit}\n`);
  chmodSync(stub, 0o755);
  return dir;
};

const accept = (dir: string, entries: unknown[]): void => {
  mkdirSync(join(dir, '.github'), {recursive: true});
  writeFileSync(join(dir, '.github', 'audit-acknowledgements.json'), JSON.stringify(entries));
};

const run = (dir: string): RunResult => {
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: {...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`},
  });
  return {status: result.status, stdout: result.stdout, stderr: result.stderr};
};

const advisory = (id: string, severity: string, title: string) => ({
  source: 1,
  name: 'left-pad',
  title,
  url: `https://github.com/advisories/${id}`,
  severity,
});

const report = (via: unknown[]) =>
  JSON.stringify({
    vulnerabilities: {
      'left-pad': {
        name: 'left-pad',
        severity: 'critical',
        isDirect: true,
        via,
        range: '<1.3.0',
        nodes: ['node_modules/left-pad'],
        effects: [],
      },
    },
    metadata: {vulnerabilities: {critical: 1, high: 0, moderate: 0, low: 0}},
  });

const CRITICAL = report([advisory('GHSA-9999-9999-9999', 'critical', 'Remote code execution')]);

const future = '2099-01-01';
const entry = (id: string) => ({
  advisory: id,
  package: 'left-pad',
  why: 'triaged, not reachable from this package',
  expires: future,
  // eslint-disable-next-line camelcase -- the acknowledgement file's own field name, fixed by check-audit.mjs
  acknowledged_by: 'a maintainer',
});

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, {recursive: true, force: true});
});

describe('check-audit on a report it cannot read', () => {
  it('refuses to report clean when npm returns its registry-failure document', () => {
    const dir = workspace(JSON.stringify({error: {code: 'E401', summary: 'Unauthorized'}}));

    expect(run(dir)).toMatchObject({status: 1});
  });

  it('names the reason rather than failing silently', () => {
    const dir = workspace(JSON.stringify({error: {code: 'E401', summary: 'Unauthorized'}}));

    expect(run(dir).stderr).toContain('returned no vulnerability report');
  });

  it('refuses to report clean when npm returns no JSON at all', () => {
    const dir = workspace('npm ERR! network timeout');

    expect(run(dir)).toMatchObject({status: 1});
  });
});

describe('check-audit acceptances', () => {
  it('fails on an unacknowledged critical advisory', () => {
    expect(run(workspace(CRITICAL))).toMatchObject({status: 1});
  });

  it('names the package, version range, advisory id and path in the blocking line', () => {
    const {stderr} = run(workspace(CRITICAL));

    expect(stderr).toContain(
      'critical: left-pad not resolvable on disk installed, affected <1.3.0 — GHSA-9999-9999-9999 Remote code execution, a direct dependency'
    );
  });

  // The report carries the affected range; a maintainer needs the version actually in the tree.
  it('names the installed version when the package is resolvable on disk', () => {
    const dir = workspace(CRITICAL);
    mkdirSync(join(dir, 'node_modules', 'left-pad'), {recursive: true});
    writeFileSync(join(dir, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({version: '1.2.0'}));

    expect(run(dir).stderr).toContain('left-pad 1.2.0 installed, affected <1.3.0');
  });

  it('passes when the acceptance names that advisory', () => {
    const dir = workspace(CRITICAL);
    accept(dir, [entry('GHSA-9999-9999-9999')]);

    expect(run(dir)).toMatchObject({status: 0});
  });

  it('does not let an acceptance for one advisory cover a different one in the same package', () => {
    const dir = workspace(CRITICAL);
    accept(dir, [entry('GHSA-1111-1111-1111')]);

    expect(run(dir)).toMatchObject({status: 1});
  });

  it('reports the unmatched acceptance as stale rather than ignoring it', () => {
    const dir = workspace(CRITICAL);
    accept(dir, [entry('GHSA-1111-1111-1111')]);

    expect(run(dir).stderr).toContain('acceptance for GHSA-1111-1111-1111 in "left-pad" matches no current advisory');
  });

  it('fails on an acceptance whose expiry has passed', () => {
    const dir = workspace(CRITICAL);
    accept(dir, [{...entry('GHSA-9999-9999-9999'), expires: '2020-01-01'}]);

    expect(run(dir)).toMatchObject({status: 1});
  });

  it('names the expired acceptance by advisory and package', () => {
    const dir = workspace(CRITICAL);
    accept(dir, [{...entry('GHSA-9999-9999-9999'), expires: '2020-01-01'}]);

    expect(run(dir).stderr).toContain('acceptance for GHSA-9999-9999-9999 in "left-pad" expired 2020-01-01');
  });

  it('still fails on a second unacknowledged advisory in an otherwise accepted package', () => {
    const dir = workspace(
      report([
        advisory('GHSA-1111-1111-1111', 'critical', 'Prototype pollution'),
        advisory('GHSA-9999-9999-9999', 'critical', 'Remote code execution'),
      ])
    );
    accept(dir, [entry('GHSA-1111-1111-1111')]);

    expect(run(dir).stderr).toContain('GHSA-9999-9999-9999');
  });

  it('passes a clean report with no acceptances', () => {
    const dir = workspace(
      JSON.stringify({vulnerabilities: {}, metadata: {vulnerabilities: {critical: 0, high: 0}}}),
      0
    );

    expect(run(dir)).toMatchObject({status: 0});
  });

  it('rejects a report carrying only metadata counts, which declares vulnerabilities it cannot list', () => {
    const dir = workspace(JSON.stringify({metadata: {vulnerabilities: {critical: 1, high: 0}}}));

    expect(run(dir)).toMatchObject({status: 1});
  });

  it('does not fabricate an advisory when two packages reach each other through via', () => {
    const dir = workspace(
      JSON.stringify({
        vulnerabilities: {
          foo: {name: 'foo', severity: 'high', isDirect: true, range: '*', via: ['bar'], effects: []},
          bar: {
            name: 'bar',
            severity: 'high',
            isDirect: false,
            range: '<2',
            via: [advisory('GHSA-aaaa-bbbb-cccc', 'high', 'Prototype pollution'), 'foo'],
            effects: ['foo'],
          },
        },
        metadata: {vulnerabilities: {critical: 0, high: 2}},
      })
    );

    // The exact findings, not the absence of a string: a crash contains no "unknown:" either.
    const {status, stderr} = run(dir);
    const lines = stderr.split('\n').filter(line => line.startsWith('check-audit: high:'));

    expect({status, lines}).toEqual({
      status: 1,
      lines: [
        'check-audit: high: foo not resolvable on disk installed, affected * — GHSA-aaaa-bbbb-cccc Prototype pollution, a direct dependency',
        'check-audit: high: bar not resolvable on disk installed, affected <2 — GHSA-aaaa-bbbb-cccc Prototype pollution, reached through foo',
      ],
    });
  });

  it('reports an advisory reached twice through via once, not twice', () => {
    const shared = advisory('GHSA-dddd-dddd-dddd', 'high', 'Shared root cause');
    const dir = workspace(
      JSON.stringify({
        vulnerabilities: {
          top: {name: 'top', severity: 'high', isDirect: true, range: '*', via: ['left', 'right'], effects: []},
          left: {name: 'left', severity: 'high', isDirect: false, range: '<2', via: [shared], effects: ['top']},
          right: {name: 'right', severity: 'high', isDirect: false, range: '<2', via: [shared], effects: ['top']},
        },
        metadata: {vulnerabilities: {critical: 0, high: 3}},
      })
    );

    const {stderr} = run(dir);
    const forTop = stderr.split('\n').filter(line => line.includes('high: top '));

    expect(forTop).toHaveLength(1);
  });

  it('keeps two advisories on one package distinct when neither carries a GHSA url', () => {
    const dir = workspace(
      JSON.stringify({
        vulnerabilities: {
          p: {
            name: 'p',
            severity: 'high',
            isDirect: true,
            range: '*',
            via: [
              {source: 101, name: 'p', title: 'A', severity: 'high'},
              {source: 101, name: 'p', title: 'B', severity: 'high'},
            ],
            effects: [],
          },
        },
        metadata: {vulnerabilities: {critical: 0, high: 1}},
      })
    );

    expect(run(dir).stderr).toContain('npm:101:B');
  });
});

// npm names a dependent in `effects` only when it is vulnerable too, so these findings ask `npm explain`.
describe('check-audit on a transitive finding whose dependents are not vulnerable', () => {
  const TRANSITIVE = JSON.stringify({
    vulnerabilities: {
      'brace-expansion': {
        name: 'brace-expansion',
        severity: 'high',
        isDirect: false,
        via: [advisory('GHSA-q2hr-2g5m-vwhr', 'high', 'Quadratic-time expansion')],
        range: '4.0.0 - 5.0.11',
        nodes: ['node_modules/brace-expansion'],
        effects: [],
      },
    },
    metadata: {vulnerabilities: {critical: 0, high: 1, moderate: 0, low: 0}},
  });

  // npm's own shape: the project root explains itself by location alone, and a workspace says it is one.
  const root = {location: '/project'};
  const edge = (name: string, from: object) => ({type: 'dev', name, spec: '*', from});
  const node = (name: string, location: string, dependents: object[]) => ({
    name,
    version: '1.0.0',
    location,
    isWorkspace: false,
    dependents,
  });
  const workspaceNode = (name: string, location: string, dependents: object[]) => ({
    ...node(name, location, dependents),
    isWorkspace: true,
  });
  const EXPLAINED = JSON.stringify([
    node('brace-expansion', 'node_modules/brace-expansion', [
      edge(
        'brace-expansion',
        node('minimatch', 'node_modules/minimatch', [
          edge('minimatch', node('glob', 'node_modules/glob', [edge('glob', root)])),
          edge('minimatch', node('eslint', 'node_modules/eslint', [edge('eslint', root)])),
          edge('minimatch', workspaceNode('@acme/web', 'packages/web', [edge('@acme/web', root)])),
        ])
      ),
    ]),
  ]);

  // The stub answers `npm explain` apart from `npm audit`, and records what it was asked to explain.
  const explaining = (explainStdout: string, explainExit = 0): string => {
    const dir = workspace(TRANSITIVE);
    writeFileSync(
      join(dir, 'bin', 'npm'),
      `#!/bin/sh\nif [ "$1" = explain ]; then\necho "$@" > explained\ncat <<'EXPLAIN'\n${explainStdout}\nEXPLAIN\nexit ${explainExit}\nfi\ncat <<'REPORT'\n${TRANSITIVE}\nREPORT\nexit 1\n`
    );
    return dir;
  };

  it('names the dependencies the project and its workspaces declare that pull it in, as npm explain reports them', () => {
    const dir = explaining(EXPLAINED);
    const {stderr} = run(dir);

    expect({
      line: stderr.split('\n').find(line => line.startsWith('check-audit: high:')),
      explained: readFileSync(join(dir, 'explained'), 'utf8').trim(),
    }).toEqual({
      line: 'check-audit: high: brace-expansion not resolvable on disk installed, affected 4.0.0 - 5.0.11 — GHSA-q2hr-2g5m-vwhr Quadratic-time expansion, reached through eslint, glob, minimatch',
      explained: 'explain node_modules/brace-expansion --json',
    });
  });

  it('keeps the path undisclosed, and still fails, when npm explain cannot say', () => {
    const {status, stderr} = run(explaining('', 1));

    expect({status, undisclosed: stderr.includes('reached through an undisclosed path')}).toEqual({
      status: 1,
      undisclosed: true,
    });
  });
});
