import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';

// A fence the gate does not recognise keeps its marker and stops being compared - the failure it exists to prevent.

const script = join(process.cwd(), 'scripts', 'check-doc-blocks.mjs');

type RunResult = {status: number | null; stdout: string; stderr: string};

const workspaces: string[] = [];

// The script reads its covered-file list from its own source, so a fixture repo has to carry that file.
const workspace = (docBody: string, sourceBody: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'doc-blocks-'));
  workspaces.push(dir);

  const covered = 'README.md';
  write(dir, covered, docBody);
  write(dir, 'src/types/sample.ts', sourceBody);
  write(dir, 'package.json', JSON.stringify({name: '@scope/fixture', version: '0.0.0'}));

  const source = readFileSync(script, 'utf8').replace(/const DOCS = \[[\s\S]*?\];/, `const DOCS = ['${covered}'];`);
  write(dir, 'scripts/check-doc-blocks.mjs', source);
  write(dir, 'scripts/lib/repo-root.mjs', 'export const root = process.cwd();\n');

  return dir;
};

const write = (dir: string, path: string, body: string): void => {
  mkdirSync(join(dir, dirname(path)), {recursive: true});
  writeFileSync(join(dir, path), body);
};

const run = (dir: string, ...args: string[]): RunResult => {
  const result = spawnSync(process.execPath, [join(dir, 'scripts', 'check-doc-blocks.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return {status: result.status, stdout: result.stdout, stderr: result.stderr};
};

const SOURCE = `export interface Sample {\n  id: string;\n}\n`;
const BODY = `interface Sample {\n  id: string;\n}`;

const doc = (fence: string, body = BODY) =>
  `# Fixture\n\n<!-- doc-block: src/types/sample.ts#Sample -->\n${fence}\n${body}\n\`\`\`\n`;

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, {recursive: true, force: true});
});

describe('check-doc-blocks fence recognition', () => {
  const DRIFTED = `interface Sample {\n  id: number;\n}`;

  it('compares a block fenced as typescript', () => {
    expect(run(workspace(doc('```typescript', DRIFTED), SOURCE))).toMatchObject({status: 1});
  });

  it('compares a block fenced as ts, which renders identically', () => {
    expect(run(workspace(doc('```ts', DRIFTED), SOURCE))).toMatchObject({status: 1});
  });

  it('compares a block fenced as tsx', () => {
    expect(run(workspace(doc('```tsx', DRIFTED), SOURCE))).toMatchObject({status: 1});
  });

  it('compares a block whose fence tag is capitalised', () => {
    expect(run(workspace(doc('```TypeScript', DRIFTED), SOURCE))).toMatchObject({status: 1});
  });

  it('compares a block whose fence carries an info string', () => {
    expect(run(workspace(doc('```ts title=example.ts', DRIFTED), SOURCE))).toMatchObject({status: 1});
  });

  it('accepts a matching block rather than reporting every fence it recognises', () => {
    expect(run(workspace(doc('```ts'), SOURCE))).toMatchObject({status: 0});
  });

  it('closes on a fence carrying trailing whitespace', () => {
    const body = `# Fixture\n\n<!-- doc-block: src/types/sample.ts#Sample -->\n\`\`\`ts\n${BODY}\n\`\`\`   \n`;

    expect(run(workspace(body, SOURCE))).toMatchObject({status: 0});
  });
});

describe('check-doc-blocks markers', () => {
  it('reports a recognised block that carries no marker at all', () => {
    const body = `# Fixture\n\n\`\`\`ts\n${BODY}\n\`\`\`\n`;

    expect(run(workspace(body, SOURCE)).stdout).toContain('carries no doc-block marker');
  });

  it('reports an opt-out that states no reason', () => {
    const body = `# Fixture\n\n<!-- doc-block: none -->\n\`\`\`ts\n${BODY}\n\`\`\`\n`;

    expect(run(workspace(body, SOURCE)).stdout).toContain('opt-out carries no reason');
  });

  it('accepts an opt-out that states one', () => {
    const body = `# Fixture\n\n<!-- doc-block: none -- invented for the guide -->\n\`\`\`ts\n${BODY}\n\`\`\`\n`;

    expect(run(workspace(body, SOURCE))).toMatchObject({status: 0});
  });

  it('reports a block whose fence is never closed rather than comparing to end of file', () => {
    const body = `# Fixture\n\n<!-- doc-block: src/types/sample.ts#Sample -->\n\`\`\`ts\n${BODY}\n`;

    expect(run(workspace(body, SOURCE)).stdout).toContain('never closed');
  });

  // Relabelling the fence keeps the marker, ends the comparison, and still renders as code.
  it('reports a marker whose fence carries a tag it does not recognise', () => {
    const body = `# Fixture\n\n<!-- doc-block: src/types/sample.ts#Sample -->\n\`\`\`js\n${BODY}\n\`\`\`\n`;

    expect(run(workspace(body, SOURCE)).stdout).toContain('not followed by a typescript fence');
  });

  it('fails rather than passing silently on a relabelled fence', () => {
    const body = `# Fixture\n\n<!-- doc-block: src/types/sample.ts#Sample -->\n\`\`\`js\n${BODY}\n\`\`\`\n`;

    expect(run(workspace(body, SOURCE))).toMatchObject({status: 1});
  });

  it('reports a marker that no fence follows at all', () => {
    const body = `# Fixture\n\n<!-- doc-block: src/types/sample.ts#Sample -->\n\nSome prose instead.\n`;

    expect(run(workspace(body, SOURCE)).stdout).toContain('not followed by a typescript fence');
  });

  it('reports a marker naming a declaration the source does not export', () => {
    const body = `# Fixture\n\n<!-- doc-block: src/types/sample.ts#Absent -->\n\`\`\`ts\n${BODY}\n\`\`\`\n`;

    expect(run(workspace(body, SOURCE)).stdout).toContain('no exported declaration named Absent');
  });
});

describe('check-doc-blocks --fix', () => {
  it('rewrites a drifted block from its source', () => {
    const dir = workspace(doc('```ts', `interface Sample {\n  id: number;\n}`), SOURCE);

    run(dir, '--fix');

    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('id: string;');
  });

  it("leaves a fence tag it did not write alone, so --fix does not rewrite the document's style", () => {
    const dir = workspace(doc('```ts', `interface Sample {\n  id: number;\n}`), SOURCE);

    run(dir, '--fix');

    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('```ts\n');
  });

  it('produces no diff on a tree that already matches', () => {
    const dir = workspace(doc('```ts'), SOURCE);
    const before = readFileSync(join(dir, 'README.md'), 'utf8');

    run(dir, '--fix');

    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(before);
  });
});
