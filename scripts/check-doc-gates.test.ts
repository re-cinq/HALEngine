import {join} from 'node:path';
import {scriptRunner} from './helpers/script-runner.js';

// A gate nobody has seen go red is an untested branch, so each case drives the real script over a fixture.

const fixtures = 'scripts/fixtures/doc-gates';
const paths = scriptRunner(join(process.cwd(), 'scripts', 'check-doc-paths.mjs'));
const spikes = scriptRunner(join(process.cwd(), 'scripts', 'check-spike-status.mjs'));
const regions = scriptRunner(join(process.cwd(), 'scripts', 'check-doc-regions.mjs'));

describe('check-doc-paths', () => {
  it('passes a document whose cited paths all resolve, including one carrying a line suffix', () => {
    expect(paths.run(`${fixtures}/paths-resolve.md`)).toMatchObject({status: 0});
  });

  it('ignores a placeholder and a glob, which name no single file', () => {
    expect(paths.run(`${fixtures}/paths-resolve.md`).stdout).toContain('2 path(s) resolve');
  });

  it('fails a document citing a path that does not exist', () => {
    expect(paths.run(`${fixtures}/paths-missing.md`)).toMatchObject({status: 1});
  });

  it('names the document, the line and the missing path', () => {
    expect(paths.run(`${fixtures}/paths-missing.md`).stderr).toContain(
      'paths-missing.md:5 names src/definitely-not-here.ts'
    );
  });
});

describe('check-spike-status', () => {
  it('passes a spike opening with a status block', () => {
    expect(spikes.run(`${fixtures}/spikes/with-status.md`)).toMatchObject({status: 0});
  });

  it('fails a spike carrying no status block', () => {
    expect(spikes.run(`${fixtures}/spikes/without-status.md`)).toMatchObject({status: 1});
  });

  it('fails a status block buried below the head of the file, where a reader will not meet it', () => {
    expect(spikes.run(`${fixtures}/spikes/buried-status.md`)).toMatchObject({status: 1});
  });

  it('names the file it refused', () => {
    expect(spikes.run(`${fixtures}/spikes/without-status.md`).stderr).toContain('without-status.md');
  });
});

describe('check-doc-regions', () => {
  it('passes an EU region in an example', () => {
    expect(regions.run(`${fixtures}/region-eu.md`)).toMatchObject({status: 0});
  });

  it('fails a non-EU region in an example', () => {
    expect(regions.run(`${fixtures}/region-us.md`)).toMatchObject({status: 1});
  });

  it('fails a non-EU region set through an environment variable', () => {
    expect(regions.run(`${fixtures}/region-env.md`)).toMatchObject({status: 1});
  });

  it('ignores a region named in prose, which records a change rather than instructing', () => {
    expect(regions.run(`${fixtures}/region-prose.md`)).toMatchObject({status: 0});
  });

  it('checks every line of a source example, which has no fence to sit inside', () => {
    expect(regions.run(`${fixtures}/region-source.ts.fixture`)).toMatchObject({status: 1});
  });

  it('names the region it refused', () => {
    expect(regions.run(`${fixtures}/region-us.md`).stderr).toContain('names the region us-central1');
  });
});
