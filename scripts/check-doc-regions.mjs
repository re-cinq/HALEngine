#!/usr/bin/env node
// Fails when a copyable example names a cloud region outside the EU.
//
// Usage:
//   node scripts/check-doc-regions.mjs [file...]    # default: README.md, docs/*.md, specs/**, example/
//
// A region literal in a document is copied into somebody's configuration, and `location` reaches the
// vendor SDK unvalidated - so a US region in an example is a cross-border transfer a reader made by
// following the docs. The prefix rule is a vendor naming convention, not a legal test: `eu-west-2` is
// London and passes this check while sitting outside the EU. Where the data may go is decided by the
// transfer-basis record, not here.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import process from 'node:process';
import {join} from 'node:path';
import {root} from './lib/repo-root.mjs';

// docs/spikes/** is excluded for the reason the other doc gates exclude it: a spike is a dated record,
// and rewriting its regions would falsify what was measured rather than repair anything.
const DEFAULT_GLOBS = ['README.md', 'docs/*.md', 'specs/**/*.md', 'example/*.ts', ':!docs/spikes/**'];

const REGION_FIELD = /\b(?:location|region)\s*:\s*['"]([a-z0-9-]+)['"]/g;
const REGION_ENV = /\b(?:AWS_REGION|GOOGLE_CLOUD_REGION|CLOUDSDK_COMPUTE_REGION)\s*=\s*([a-z0-9-]+)/g;
const EU = /^(?:eu-|europe-)/;
const FENCE = /^( {0,3})(`{3,}|~{3,})/;

const files = process.argv.slice(2);
const documents = files.length > 0 ? files : tracked();
const findings = [];
let checked = 0;

for (const doc of documents) {
  const lines = readFileSync(join(root, doc), 'utf8').split('\n');

  // Only inside a fence, and only for markdown: a region a reader copies lives in an example, while
  // prose quoting an old value - a spec recording the defect it fixed - is a record, not a snippet.
  const markdown = doc.endsWith('.md');
  let open = markdown ? null : {marker: '', indent: ''};

  lines.forEach((line, index) => {
    const fence = FENCE.exec(line);

    if (markdown && fence) {
      // CommonMark allows ~~~ as well as ```, up to three spaces of indent, and closes only on the
      // same character: a fence in a numbered list is indented, which is how a guide writes a step.
      const [, indent, marker] = fence;
      if (open === null) open = {marker: marker[0], indent};
      else if (marker[0] === open.marker && marker.length >= open.marker.length) open = null;
      return;
    }
    if (open === null) return;

    for (const pattern of [REGION_FIELD, REGION_ENV]) {
      for (const match of line.matchAll(pattern)) {
        checked += 1;
        if (EU.test(match[1])) continue;

        findings.push(`${doc}:${index + 1} names the region ${match[1]}`);
      }
    }
  });
}

for (const finding of findings) process.stderr.write(`check-doc-regions: ${finding}\n`);

if (findings.length > 0) {
  process.stderr.write(
    `\ncheck-doc-regions: ${findings.length} non-EU region literal(s).\nAn example region must start eu- or europe-; the prefix is a naming convention, not a guarantee of where the data rests.\n`
  );
  process.exit(1);
}

process.stdout.write(
  `check-doc-regions: ${checked} region literal(s), all EU, across ${documents.length} document(s)\n`
);

function tracked() {
  const out = execFileSync('git', ['ls-files', ...DEFAULT_GLOBS], {cwd: root, encoding: 'utf8'});
  return out.trim().split('\n').filter(Boolean);
}
