#!/usr/bin/env node
// Fails when a repository path written in a document does not resolve.
//
// Usage:
//   node scripts/check-doc-paths.mjs [file...]     # default: every tracked markdown document
//
// A path in prose is a citation, and a citation nobody resolves rots silently: a file moves, the
// sentence naming it stays, and the next reader follows it to nothing. Line suffixes are dropped
// before resolving - the line a path cites is checked by scripts/repoint-spec-anchors.mjs, not here.
import {existsSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import process from 'node:process';
import {root} from './lib/repo-root.mjs';
import {join} from 'node:path';

// docs/spikes/** is excluded for the reason check-doc-blocks.mjs excludes it: a spike records what was
// believed when it was written, and it names files this repository never had.
const DEFAULT_GLOBS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.specify/*.md',
  'docs/*.md',
  'specs/**/*.md',
  // git pathspec globs cross directory separators, so the exclusion is explicit rather than implied.
  ':!docs/spikes/**',
];

// A backticked path into the source tree, with an optional :line or :line-line suffix.
const PATH_IN_PROSE =
  /`((?:src|scripts|example|smoke|docs|specs|adrs|dist|\.github|\.specify)\/[A-Za-z0-9_./-]+?)(?::\d+(?:-\d+)?)?`/g;

// A placeholder is not a citation: `src/providers/<name>/index.ts` names a file the reader creates.
const PLACEHOLDER = /[*<>{}]|\.\.\./;

// Paths that legitimately do not resolve, each with the reason it does not. An exception has to be
// written down to be an exception; without this the gate is narrowed instead, which hides the rest.
const ABSENT_BY_DESIGN = new Map([
  ['.github/audit-acknowledgements.json', 'created by whoever records the first audit acceptance; absent means none'],
  ['docs/adding-tool-evaluation.md', 'the path this document had before it moved under docs/spikes/'],
]);

const files = process.argv.slice(2);
const documents = files.length > 0 ? files : tracked();
const findings = [];
let checked = 0;

for (const doc of documents) {
  const lines = readFileSync(join(root, doc), 'utf8').split('\n');

  lines.forEach((line, index) => {
    for (const match of line.matchAll(PATH_IN_PROSE)) {
      const path = match[1];
      if (PLACEHOLDER.test(path)) continue;

      if (ABSENT_BY_DESIGN.has(path)) continue;

      checked += 1;
      if (!existsSync(join(root, path))) findings.push(`${doc}:${index + 1} names ${path}, which does not exist`);
    }
  });
}

for (const finding of findings) process.stderr.write(`check-doc-paths: ${finding}\n`);

if (findings.length > 0) {
  process.stderr.write(
    `\ncheck-doc-paths: ${findings.length} unresolved path(s) across ${documents.length} document(s).\n`
  );
  process.stderr.write('Correct the path, or write it as a placeholder if it names a file the reader creates.\n');
  process.exit(1);
}

process.stdout.write(`check-doc-paths: ${checked} path(s) resolve across ${documents.length} document(s)\n`);

function tracked() {
  const out = execFileSync('git', ['ls-files', ...DEFAULT_GLOBS], {cwd: root, encoding: 'utf8'});
  return out.trim().split('\n').filter(Boolean);
}
