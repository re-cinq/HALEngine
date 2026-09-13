#!/usr/bin/env node
// Fails when a `uses:` reference anywhere under .github/ is not pinned to a full
// 40-hex commit SHA. A tag is a mutable pointer its owner can repoint, and these
// workflows run with repository credentials - one of them holds id-token: write
// and signs what it publishes.
//
// Usage:
//   node scripts/check-action-pins.mjs [dir]
//
// The whole of .github/, not just workflows/: a composite action under
// .github/actions/ carries its own `uses:` lines, runs inside whichever job calls
// it, and is exactly as able to repoint itself as a workflow step is.
//
// Parsed rather than grepped. A line scan reads one YAML spelling and misses the
// rest: `steps: [{uses: actions/checkout@v4}]` is legal flow style and was invisible
// to it, which is a bypass of the gate standing between a mutable tag and publish
// rights. The parser sees every spelling of the same document.
//
// Local `./` and `docker://` references are not pinnable this way and are skipped.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';
import process from 'node:process';
import {parseDocument, visit, isScalar} from 'yaml';
import {root} from './lib/repo-root.mjs';

const SHA = /^[0-9a-f]{40}$/;

const scanDir = process.argv[2] ?? '.github';
const findings = [];

function yamlFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...yamlFiles(path));
    else if (/\.ya?ml$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

const lineOf = (source, offset) => source.slice(0, offset).split('\n').length;

function report(file, line, ref) {
  process.stderr.write(`check-action-pins: ${file}:${line} pins "${ref}" — expected a 40-hex commit SHA\n`);
  findings.push(ref);
}

for (const path of yamlFiles(isAbsolute(scanDir) ? scanDir : join(root, scanDir))) {
  const file = relative(root, path);
  const source = readFileSync(path, 'utf8');
  const doc = parseDocument(source);

  // A file nobody can parse is a file nobody can vouch for, and a security gate does not skip it.
  if (doc.errors.length > 0) {
    process.stderr.write(`check-action-pins: ${file} could not be parsed — ${doc.errors[0].message}\n`);
    findings.push(file);
    continue;
  }

  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== 'uses') return;

      const line = lineOf(source, pair.value?.range?.[0] ?? pair.key.range[0]);
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string') {
        report(file, line, String(pair.value?.value ?? pair.value));
        return;
      }

      const ref = pair.value.value;
      if (ref.startsWith('./') || ref.startsWith('docker://')) return;
      if (!SHA.test(ref.slice(ref.lastIndexOf('@') + 1))) report(file, line, ref);
    },
  });
}

if (findings.length > 0) {
  process.stderr.write(`\ncheck-action-pins: ${findings.length} unpinned reference(s).\n`);
  process.stderr.write('Pin with: gh api repos/<owner>/<repo>/commits/<tag> --jq .sha\n');
  process.stderr.write('and keep the tag in a trailing comment, e.g. `uses: actions/checkout@<sha> # v4.2.2`\n');
  process.exit(1);
}

process.stdout.write('check-action-pins: every uses: reference is SHA-pinned.\n');
