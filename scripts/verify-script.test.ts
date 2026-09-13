import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseDocument} from 'yaml';
import {root} from './lib/repo-root.mjs';

// `npm run verify` is what CONTRIBUTING.md tells a contributor to run; this is what keeps it true.

const read = (path: string) => readFileSync(join(root, path), 'utf8');

// The two CI steps that are not `npm run` diff against origin/main, so neither runs on a checkout.
const ciScripts = (): string[] => {
  const workflow = parseDocument(read('.github/workflows/ci.yml')).toJS() as {
    jobs: Record<string, {steps: {run?: string}[]}>;
  };
  const {verify} = workflow.jobs;
  const steps: {run?: string}[] = verify.steps;

  return steps
    .map(step => /^npm run ([\w:-]+)$/.exec((step.run ?? '').trim())?.[1])
    .filter((name): name is string => Boolean(name));
};

const scripts = (): Record<string, string> => (JSON.parse(read('package.json')) as Manifest).scripts;

const verifyScripts = (): string[] => {
  const parts: string[] = scripts().verify.split('&&');

  return parts.map(part => part.trim().replace(/^npm run /, ''));
};

interface Manifest {
  scripts: Record<string, string>;
}

describe('npm run verify', () => {
  it('runs every npm script the CI verify job runs, in the same order', () => {
    expect(verifyScripts()).toEqual(ciScripts());
  });

  it('names scripts that exist, so a rename fails here rather than at the contributor', () => {
    const defined = scripts();

    expect(verifyScripts().filter(name => !defined[name])).toEqual([]);
  });
});
