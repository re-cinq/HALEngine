import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expectUsageError, git, runScript, writeInRepo as write, type RunResult} from './helpers/script-runner.js';

// Each case builds a throwaway git repo: the subject is base ref versus working tree.

const script = join(process.cwd(), 'scripts', 'repoint-spec-anchors.mjs');
const SPEC = 'specs/foo/spec.md';
const ROOT_SPEC = '.specify/spec.md';
// Not a .test.ts: the declaration rule has its own block below.
const CITED = 'src/foo.ts';

const run = (repo: string, ...args: string[]): RunResult => runScript(script, args, {cwd: repo});
const read = (repo: string, path: string): string => readFileSync(join(repo, path), 'utf8');
const lines = (content: string[]): string => `${content.join('\n')}\n`;
const summary = (result: RunResult): string => {
  const [first] = result.stdout.split('\n');

  return first;
};

const asSpec = (...anchors: string[]): string =>
  `${anchors.map((anchor, i) => `Statement ${i + 1}. ([validated by](${anchor}))`).join('\n\n')}\n`;

const asShortSpec = (...links: Array<[label: number, anchor: string]>): string =>
  `${links.map(([label, anchor], i) => `Statement ${i + 1}. ([L${label}](${anchor}))`).join('\n\n')}\n`;

const commit = (repo: string, message: string): void => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
};

const writeCited = (repo: string, content: string[]): void => write(repo, CITED, lines(content));

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'repoint-spec-anchors-'));

  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeCited(repo, ['alpha', 'beta', 'gamma', 'delta']);
  write(repo, SPEC, asSpec(`../../${CITED}#L2`, `../../${CITED}#L4`));
  write(repo, ROOT_SPEC, asSpec(`../${CITED}#L3`));
  commit(repo, 'baseline');

  return repo;
};

describe('repoint-spec-anchors', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo, {recursive: true, force: true});
  });

  describe('repointing', () => {
    it("moves each anchor to where the base ref's line content now lives", () => {
      writeCited(repo, ['intro', 'intro2', 'alpha', 'beta', 'gamma', 'delta']);

      const result = run(repo, 'main');

      expect({status: result.status, summary: summary(result), spec: read(repo, SPEC)}).toEqual({
        status: 0,
        summary: 'repointed: 3, up to date: 0, unresolved: 0, relabelled: 0',
        spec: asSpec(`../../${CITED}#L4`, `../../${CITED}#L6`),
      });
    });

    it('is a no-op the second time, because the baseline is read from the base ref', () => {
      writeCited(repo, ['intro', 'alpha', 'beta', 'gamma', 'delta']);
      run(repo, 'main');
      const afterFirst = read(repo, SPEC);

      const second = run(repo, 'main');

      expect({status: second.status, summary: summary(second), spec: read(repo, SPEC)}).toEqual({
        status: 0,
        summary: 'repointed: 0, up to date: 3, unresolved: 0, relabelled: 0',
        spec: afterFirst,
      });
    });

    it('reports an anchor whose baseline content is gone as unresolved, and leaves it alone', () => {
      writeCited(repo, ['alpha', 'BETA', 'gamma', 'delta']);
      const before = read(repo, SPEC);

      const result = run(repo, 'main');

      expect({
        status: result.status,
        summary: summary(result),
        namesTheAnchor: result.stderr.includes(`unresolved ${SPEC}: ../../${CITED}#L2`),
        spec: read(repo, SPEC),
      }).toEqual({
        status: 1,
        summary: 'repointed: 0, up to date: 2, unresolved: 1, relabelled: 0',
        namesTheAnchor: true,
        spec: before,
      });
    });
  });

  describe('--check', () => {
    it('exits 1 listing stale anchors and rewrites nothing', () => {
      writeCited(repo, ['intro', 'alpha', 'beta', 'gamma', 'delta']);
      const before = read(repo, SPEC);

      const check = run(repo, '--check', 'main');

      expect({
        status: check.status,
        summary: summary(check),
        detail: check.stderr.includes(`stale ${SPEC}: ../../${CITED}#L2 -> #L3`),
        spec: read(repo, SPEC),
      }).toEqual({
        status: 1,
        summary: 'stale: 3, up to date: 0, unresolved: 0, mislabelled: 0',
        detail: true,
        spec: before,
      });
    });

    it('exits 0 once a plain run has repointed them', () => {
      writeCited(repo, ['intro', 'alpha', 'beta', 'gamma', 'delta']);
      run(repo, 'main');

      const check = run(repo, '--check', 'main');

      expect({status: check.status, summary: summary(check)}).toEqual({
        status: 0,
        summary: 'stale: 0, up to date: 3, unresolved: 0, mislabelled: 0',
      });
    });
  });

  describe('duplicate content', () => {
    it('picks the occurrence whose surrounding lines match the baseline', () => {
      writeCited(repo, ['x', 'y', 'beta', 'z', 'beta', 'gamma', 'delta']);

      run(repo, 'main');

      expect(read(repo, SPEC)).toEqual(asSpec(`../../${CITED}#L5`, `../../${CITED}#L7`));
    });

    it('sends two identical assertions to their own occurrences', () => {
      writeCited(repo, ['setup', 'expect(height).toBe(200);', 'teardown', 'expect(height).toBe(200);']);
      write(repo, SPEC, asSpec(`../../${CITED}#L2`, `../../${CITED}#L4`));
      write(repo, ROOT_SPEC, asSpec(`../${CITED}#L2`));
      commit(repo, 'duplicated assertion baseline');
      writeCited(repo, [
        'intro1',
        'intro2',
        'intro3',
        'setup',
        'expect(height).toBe(200);',
        'teardown',
        'expect(height).toBe(200);',
      ]);

      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, SPEC)}).toEqual({
        status: 0,
        spec: asSpec(`../../${CITED}#L5`, `../../${CITED}#L7`),
      });
    });

    it('tells apart duplicates that only differ four lines out', () => {
      const block = ['s1', 's2', 's3', 'dupe', 's4', 's5', 's6'];

      writeCited(repo, ['uniqA', ...block, 'uniqB', ...block, 'end']);
      write(repo, SPEC, asSpec(`../../${CITED}#L13`));
      write(repo, ROOT_SPEC, asSpec(`../${CITED}#L1`));
      commit(repo, 'duplicates differing four lines out');
      const baseline = read(repo, CITED);

      write(repo, CITED, `intro1\nintro2\n${baseline}`);
      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, SPEC)}).toEqual({
        status: 0,
        spec: asSpec(`../../${CITED}#L15`),
      });
    });

    it('refuses to guess when the context ties, and rewrites nothing', () => {
      const block = ['header', 'alpha', 'dupe', 'beta', 'tail'];

      writeCited(repo, [...block, ...block, ...block, ...block]);
      write(repo, SPEC, asSpec(`../../${CITED}#L8`));
      write(repo, ROOT_SPEC, asSpec(`../${CITED}#L1`));
      commit(repo, 'identical duplicated blocks');
      const before = read(repo, SPEC);

      const rewrite = run(repo, 'main');

      expect({
        status: rewrite.status,
        unresolved: summary(rewrite).includes('unresolved: 1'),
        ambiguity: rewrite.stderr.includes('matches ambiguously at lines 8, 13'),
        spec: read(repo, SPEC),
      }).toEqual({status: 1, unresolved: true, ambiguity: true, spec: before});
    });
  });

  describe('specs with no baseline to reason from', () => {
    it('skips a spec whose ordered anchor paths differ from the base ref', () => {
      write(repo, SPEC, asSpec(`../../${CITED}#L2`, `../../${CITED}#L4`, `../../${CITED}#L1`));
      writeCited(repo, ['intro', 'alpha', 'beta', 'gamma', 'delta']);
      const before = read(repo, SPEC);

      const result = run(repo, 'main');

      expect({
        status: result.status,
        skipped: result.stderr.includes(`skipped ${SPEC}: anchor set differs from main`),
        spec: read(repo, SPEC),
        otherSpecStillRepointed: read(repo, ROOT_SPEC),
      }).toEqual({
        status: 0,
        skipped: true,
        spec: before,
        otherSpecStillRepointed: asSpec(`../${CITED}#L4`),
      });
    });

    it('skips a spec absent from the base ref', () => {
      write(repo, 'specs/new/spec.md', asSpec(`../../${CITED}#L1`));

      const result = run(repo, 'main');

      expect({
        status: result.status,
        skipped: result.stderr.includes('skipped specs/new/spec.md: not present at main'),
        spec: read(repo, 'specs/new/spec.md'),
      }).toEqual({status: 0, skipped: true, spec: asSpec(`../../${CITED}#L1`)});
    });

    it('takes a manually retargeted anchor as authored and never rewrites it', () => {
      write(repo, SPEC, asSpec(`../../${CITED}#L3`, `../../${CITED}#L1`));
      const before = read(repo, SPEC);

      const check = run(repo, '--check', 'main');
      const rewrite = run(repo, 'main');

      expect({
        check: check.status,
        reported: check.stdout.includes('retargeted (not checked): 2'),
        rewrite: rewrite.status,
        spec: read(repo, SPEC),
      }).toEqual({check: 0, reported: true, rewrite: 0, spec: before});
    });
  });

  describe('rotten anchors', () => {
    it('fails in both modes when the anchor lands on a blank line', () => {
      writeCited(repo, ['alpha', '', 'gamma', 'delta']);
      commit(repo, 'blank line at L2');
      const before = read(repo, SPEC);

      const check = run(repo, '--check', 'main');
      const rewrite = run(repo, 'main');

      expect({
        check: check.status,
        rewrite: rewrite.status,
        detail: check.stderr.includes(`rotten ${SPEC}: ../../${CITED}#L2 -> #L2 lands on a blank or closing line`),
        spec: read(repo, SPEC),
      }).toEqual({check: 1, rewrite: 1, detail: true, spec: before});
    });

    it('treats a line of closing punctuation as contentless', () => {
      writeCited(repo, ['alpha', '  });', 'gamma', 'delta']);
      commit(repo, 'closing brace at L2');

      const check = run(repo, '--check', 'main');

      expect({
        status: check.status,
        detail: check.stderr.includes('#L2 lands on a blank or closing line'),
      }).toEqual({status: 1, detail: true});
    });

    it('reports a citation into a file that is not in the working tree', () => {
      write(repo, 'specs/bar/spec.md', asSpec('../../src/gone.ts#L1'));

      const check = run(repo, '--check', 'main');

      expect(check.stderr).toContain('src/gone.ts does not exist in the working tree');
    });

    it('reports an anchor past the end of the cited file', () => {
      writeCited(repo, ['alpha', 'beta']);
      write(repo, SPEC, asSpec(`../../${CITED}#L9`));

      const check = run(repo, '--check', 'main');

      expect(check.stderr).toContain(`#L9 is beyond the end of ${CITED}`);
    });

    it('does not report one the rewrite itself repoints', () => {
      writeCited(repo, ['alpha', '', 'beta', 'gamma', 'delta']);

      const rewrite = run(repo, 'main');

      expect({
        status: rewrite.status,
        summary: summary(rewrite),
        mentionsRotten: rewrite.stderr.includes('rotten'),
        spec: read(repo, SPEC),
      }).toEqual({
        status: 0,
        summary: 'repointed: 3, up to date: 0, unresolved: 0, relabelled: 0',
        mentionsRotten: false,
        spec: asSpec(`../../${CITED}#L3`, `../../${CITED}#L5`),
      });
    });

    it('still checks a spec that was skipped for a differing anchor set', () => {
      writeCited(repo, ['alpha', 'beta', 'gamma', '']);
      write(repo, SPEC, asSpec(`../../${CITED}#L2`, `../../${CITED}#L4`, `../../${CITED}#L1`));

      const check = run(repo, '--check', 'main');

      expect({
        status: check.status,
        skipped: check.stderr.includes(`skipped ${SPEC}: anchor set differs from main`),
        rotten: check.stderr.includes(`rotten ${SPEC}: ../../${CITED}#L4 -> #L4 lands on a blank or closing line`),
      }).toEqual({status: 1, skipped: true, rotten: true});
    });
  });

  describe('short-form labels', () => {
    it('syncs a label to the line its own href names', () => {
      write(repo, SPEC, asShortSpec([9, `../../${CITED}#L2`]));
      commit(repo, 'short-form label out of sync');

      const result = run(repo, 'main');

      expect({
        status: result.status,
        relabelled: summary(result).includes('relabelled: 1'),
        spec: read(repo, SPEC),
      }).toEqual({status: 0, relabelled: true, spec: asShortSpec([2, `../../${CITED}#L2`])});
    });

    it('carries the label along when the href is repointed', () => {
      write(repo, SPEC, asShortSpec([2, `../../${CITED}#L2`]));
      commit(repo, 'short-form label in sync');
      writeCited(repo, ['intro', 'intro2', 'alpha', 'beta', 'gamma', 'delta']);

      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, SPEC)}).toEqual({
        status: 0,
        spec: asShortSpec([4, `../../${CITED}#L4`]),
      });
    });

    it('--check names a label disagreeing with its href and rewrites nothing', () => {
      write(repo, SPEC, asShortSpec([9, `../../${CITED}#L2`]));
      commit(repo, 'short-form label out of sync');
      const before = read(repo, SPEC);

      const check = run(repo, '--check', 'main');

      expect({
        status: check.status,
        counted: summary(check).includes('mislabelled: 1'),
        detail: check.stderr.includes(`mislabelled ${SPEC}: ../../${CITED}#L2 -> label reads L9`),
        spec: read(repo, SPEC),
      }).toEqual({status: 1, counted: true, detail: true, spec: before});
    });

    it('converges: after one plain run, check passes and a second run is a no-op', () => {
      write(repo, SPEC, asShortSpec([9, `../../${CITED}#L2`]));
      commit(repo, 'short-form label out of sync');
      run(repo, 'main');
      const afterFirst = read(repo, SPEC);

      const check = run(repo, '--check', 'main');
      const second = run(repo, 'main');

      expect({
        check: check.status,
        mislabelled: summary(check).includes('mislabelled: 0'),
        second: second.status,
        spec: read(repo, SPEC),
      }).toEqual({check: 0, mislabelled: true, second: 0, spec: afterFirst});
    });

    it('syncs labels even in a spec skipped for a differing anchor set', () => {
      write(repo, SPEC, asShortSpec([2, `../../${CITED}#L2`], [4, `../../${CITED}#L4`]));
      commit(repo, 'two short-form labels in sync');
      write(repo, SPEC, asShortSpec([9, `../../${CITED}#L2`], [4, `../../${CITED}#L4`], [1, `../../${CITED}#L1`]));

      const check = run(repo, '--check', 'main');
      const rewrite = run(repo, 'main');

      expect({
        check: check.status,
        skipped: check.stderr.includes(`skipped ${SPEC}: anchor set differs from main`),
        rewrite: rewrite.status,
        spec: read(repo, SPEC),
      }).toEqual({
        check: 1,
        skipped: true,
        rewrite: 0,
        spec: asShortSpec([2, `../../${CITED}#L2`], [4, `../../${CITED}#L4`], [1, `../../${CITED}#L1`]),
      });
    });

    it('leaves a descriptive label alone while syncing a short-form one beside it', () => {
      const mixed = (label: number): string =>
        `Statement 1. ([validated by](../../${CITED}#L2), [L${label}](../../${CITED}#L4))\n`;

      write(repo, SPEC, mixed(9));
      commit(repo, 'mixed labels');

      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, SPEC)}).toEqual({
        status: 0,
        spec: mixed(4),
      });
    });

    it('reports a label whose href is rotten rather than silently syncing it', () => {
      write(repo, SPEC, asShortSpec([2, `../../${CITED}#L2`]));
      writeCited(repo, ['alpha', '', 'gamma', 'delta']);
      commit(repo, 'short-form label href on a blank line');
      const before = read(repo, SPEC);

      const check = run(repo, '--check', 'main');
      const rewrite = run(repo, 'main');

      expect({
        check: check.status,
        rewrite: rewrite.status,
        rotten: check.stderr.includes(`rotten ${SPEC}: ../../${CITED}#L2 -> #L2 lands on a blank or closing line`),
        spec: read(repo, SPEC),
      }).toEqual({check: 1, rewrite: 1, rotten: true, spec: before});
    });
  });

  describe('anchors into files that are not tests', () => {
    it('repoints docs, README and script citations alike', () => {
      write(repo, 'docs/notes.md', lines(['cited note', 'other note']));
      write(repo, 'README.md', lines(['cited readme line', 'other line']));
      write(repo, 'scripts/check.sh', lines(['cited command', 'other command']));
      write(
        repo,
        'specs/bar/spec.md',
        asSpec('../../docs/notes.md#L1', '../../README.md#L1', '../../scripts/check.sh#L1')
      );
      commit(repo, 'non-test anchors baseline');
      write(repo, 'docs/notes.md', lines(['inserted', 'cited note', 'other note']));
      write(repo, 'README.md', lines(['inserted', 'cited readme line', 'other line']));
      write(repo, 'scripts/check.sh', lines(['inserted', 'cited command', 'other command']));

      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, 'specs/bar/spec.md')}).toEqual({
        status: 0,
        spec: asSpec('../../docs/notes.md#L2', '../../README.md#L2', '../../scripts/check.sh#L2'),
      });
    });

    it('repoints a citation into a root config file', () => {
      write(repo, 'jest.config.js', lines(['cited option', 'other option']));
      write(repo, 'specs/bar/spec.md', asSpec('../../jest.config.js#L1'));
      commit(repo, 'config anchor baseline');
      write(repo, 'jest.config.js', lines(['inserted', 'cited option', 'other option']));

      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, 'specs/bar/spec.md')}).toEqual({
        status: 0,
        spec: asSpec('../../jest.config.js#L2'),
      });
    });

    it('repoints citations into a workflow and package.json', () => {
      write(repo, '.github/workflows/x.yml', lines(['      - name: Build', '        run: npm run build']));
      write(repo, 'package.json', lines(['  "name": "demo",', '  "version": "0.1.0"']));
      write(repo, 'specs/bar/spec.md', asSpec('../../.github/workflows/x.yml#L1', '../../package.json#L1'));
      commit(repo, 'workflow and manifest anchor baseline');
      write(repo, '.github/workflows/x.yml', lines(['name: CI', '      - name: Build', '        run: npm run build']));
      write(repo, 'package.json', lines(['{', '  "name": "demo",', '  "version": "0.1.0"']));

      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, 'specs/bar/spec.md')}).toEqual({
        status: 0,
        spec: asSpec('../../.github/workflows/x.yml#L2', '../../package.json#L2'),
      });
    });

    it('leaves a link whose fragment is not a line number untouched', () => {
      const fragments = asSpec('../../docs/notes.md#A1', '../../docs/at-pass-<date>.md#A1');

      write(repo, 'docs/notes.md', lines(['cited note', 'other note']));
      write(repo, 'specs/bar/spec.md', fragments);
      commit(repo, 'fragment anchors baseline');
      write(repo, 'docs/notes.md', lines(['inserted', 'cited note', 'other note']));

      const result = run(repo, 'main');

      expect({status: result.status, spec: read(repo, 'specs/bar/spec.md')}).toEqual({
        status: 0,
        spec: fragments,
      });
    });
  });

  describe('citations into a test file', () => {
    const TEST = 'src/bar.test.ts';
    const TEST_SPEC = 'specs/bar/spec.md';
    const suite = (...body: string[]): string[] => ['describe("the subject", () => {', ...body, '});'];

    const writeSuite = (anchorLine: number, ...body: string[]): void => {
      write(repo, TEST, lines(suite(...body)));
      write(repo, TEST_SPEC, asSpec(`../../${TEST}#L${anchorLine}`));
    };

    it('accepts an anchor on the it declaration itself', () => {
      writeSuite(2, '  it("does the thing", () => {', '    expect(1).toBe(1);', '  });');
      commit(repo, 'test-file citation');

      const check = run(repo, '--check', 'main');

      expect(check.status).toBe(0);
    });

    it('accepts an anchor on the describe line', () => {
      writeSuite(1, '  it("does the thing", () => {', '    expect(1).toBe(1);', '  });');
      commit(repo, 'describe citation');

      const check = run(repo, '--check', 'main');

      expect(check.status).toBe(0);
    });

    it('reports an anchor that lands inside the test body as rotten', () => {
      writeSuite(3, '  it("does the thing", () => {', '    expect(1).toBe(1);', '  });');
      commit(repo, 'body citation');

      const check = run(repo, '--check', 'main');

      expect(check.stderr).toContain(`#L3 is not an it/test/describe declaration in ${TEST}`);
    });

    it('fails a body-line anchor in rewrite mode too, and rewrites nothing', () => {
      writeSuite(3, '  it("does the thing", () => {', '    expect(1).toBe(1);', '  });');
      commit(repo, 'body citation');
      const before = read(repo, TEST_SPEC);

      const rewrite = run(repo, 'main');

      expect({status: rewrite.status, spec: read(repo, TEST_SPEC)}).toEqual({
        status: 1,
        spec: before,
      });
    });

    it('accepts the modified forms of a declaration', () => {
      write(repo, TEST, lines(['it.each([1])("each", () => {});', 'test.skip("skipped", () => {});']));
      write(repo, TEST_SPEC, asSpec(`../../${TEST}#L1`, `../../${TEST}#L2`));
      commit(repo, 'modified declarations');

      const check = run(repo, '--check', 'main');

      expect(check.status).toBe(0);
    });

    it('repoints a test citation from one declaration to another as lines shift', () => {
      writeSuite(2, '  it("first", () => {});', '  it("second", () => {});');
      commit(repo, 'two cases');
      write(
        repo,
        TEST,
        lines(suite('  it("inserted", () => {});', '  it("first", () => {});', '  it("second", () => {});'))
      );

      const rewrite = run(repo, 'main');

      expect({status: rewrite.status, spec: read(repo, TEST_SPEC)}).toEqual({
        status: 0,
        spec: asSpec(`../../${TEST}#L3`),
      });
    });

    it('holds only test files to the rule, so a non-declaration line elsewhere passes', () => {
      write(repo, 'tsconfig.json', lines(['  "strict": true,', '  "target": "es2022"']));
      write(repo, TEST_SPEC, asSpec('../../tsconfig.json#L1'));
      commit(repo, 'config citation');

      const check = run(repo, '--check', 'main');

      expect(check.status).toBe(0);
    });
  });

  describe('arguments', () => {
    it('defaults the base ref to origin/main', () => {
      const clone = mkdtempSync(join(tmpdir(), 'repoint-spec-anchors-clone-'));
      const cloned = join(clone, 'repo');

      execFileSync('git', ['clone', '-q', repo, cloned], {stdio: 'ignore'});
      write(repo, CITED, lines(['intro', 'alpha', 'beta', 'gamma', 'delta']));
      write(cloned, CITED, lines(['intro', 'alpha', 'beta', 'gamma', 'delta']));

      const result = run(cloned);
      const spec = read(cloned, SPEC);

      rmSync(clone, {recursive: true, force: true});

      expect({status: result.status, spec}).toEqual({
        status: 0,
        spec: asSpec(`../../${CITED}#L3`, `../../${CITED}#L5`),
      });
    });

    it('exits 2 naming a base ref that does not resolve', () => {
      const result = run(repo, 'no-such-ref');

      expect({status: result.status, named: result.stderr.includes('no-such-ref')}).toEqual({
        status: 2,
        named: true,
      });
    });

    it('exits 2 with usage on an unknown flag', () => {
      expectUsageError(run(repo, '--frobnicate'));
    });

    it('exits 2 with usage on more than one base ref', () => {
      expectUsageError(run(repo, 'main', 'also-main'));
    });
  });

  // Last in the file on purpose: the spec cites this file by line, and a test inserted above would move them all.
  describe('a cited file a formatter rewrote', () => {
    it('follows a line a formatter rewrote, because quotes and spacing are not drift', () => {
      writeCited(repo, ['alpha', 'it("beta", () => {', 'gamma', 'delta']);
      commit(repo, 'double quotes');
      writeCited(repo, ['intro', 'alpha', "it('beta', () => {", 'gamma', 'delta']);

      const {status} = run(repo, 'main');

      expect({status, spec: read(repo, SPEC)}).toEqual({
        status: 0,
        spec: asSpec(`../../${CITED}#L3`, `../../${CITED}#L5`),
      });
    });

    it('reads a file reformatted in place as up to date under --check', () => {
      writeCited(repo, ['alpha', 'it("beta", () => {', 'gamma', 'delta']);
      commit(repo, 'double quotes');
      writeCited(repo, ['alpha', "it('beta', () => {", 'gamma', 'delta']);

      const {status, stdout} = run(repo, '--check', 'main');

      expect({status, upToDate: stdout.includes('up to date: 3')}).toEqual({status: 0, upToDate: true});
    });
  });
});
