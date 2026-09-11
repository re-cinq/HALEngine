#!/usr/bin/env node
// Fails when a spike document does not open with a status block.
//
// Usage:
//   node scripts/check-spike-status.mjs [file...]   # default: every tracked docs/spikes/*.md
//
// A spike records what somebody believed on the day they wrote it. Served as documentation without
// that said out loud - and Lore does serve these - it reads as current design, which is how a
// superseded proposal becomes the thing a reader implements.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import process from 'node:process';
import {join} from 'node:path';
import {root} from './lib/repo-root.mjs';

const HEAD_LINES = 12;
const STATUS = /^>\s*\*\*Status:/;

const files = process.argv.slice(2);
const documents = files.length > 0 ? files : tracked();
const findings = [];

for (const doc of documents) {
  const head = readFileSync(join(root, doc), 'utf8').split('\n').slice(0, HEAD_LINES);
  if (head.some(line => STATUS.test(line))) continue;

  findings.push(`${doc} has no status block in its first ${HEAD_LINES} lines`);
}

for (const finding of findings) process.stderr.write(`check-spike-status: ${finding}\n`);

if (findings.length > 0) {
  process.stderr.write(
    `\ncheck-spike-status: ${findings.length} spike(s) without a status block.\nOpen the file with a blockquote line starting "**Status:" saying what shipped, what was superseded, and when it was reviewed.\n`
  );
  process.exit(1);
}

process.stdout.write(`check-spike-status: ${documents.length} spike(s) carry a status block\n`);

function tracked() {
  const out = execFileSync('git', ['ls-files', 'docs/spikes/*.md'], {cwd: root, encoding: 'utf8'});
  return out.trim().split('\n').filter(Boolean);
}
