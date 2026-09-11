// Every fenced typescript block in a documented file is generated from source, not transcribed.

// Hand transcription is how the repo shipped a wrong frame order, a field name that
// never existed and three config keys that are not read. A marker names where a block
// comes from; --fix rewrites the block from there.

import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import process from 'node:process';
import {root} from './lib/repo-root.mjs';

const USAGE =
  'usage: check-doc-blocks.mjs [--fix]\n\nmarkers, on the line before the fence:\n  <!-- doc-block: src/types/ai.ts#AIProvider -->   an exported declaration\n  <!-- doc-block: example/server.ts#quick-start --> a #region span in a checked example\n  <!-- doc-block: none -- reason -->                opt out, reason required';

const DOCS = [
  'README.md',
  'CLAUDE.md',
  '.specify/spec.md',
  'docs/getting-started.md',
  'docs/adding-a-tool.md',
  'docs/adding-a-message-type.md',
  'docs/coding-practices.md',
  'specs/hal-engine-architecture/spec.md',
  'specs/hal-engine-providers/spec.md',
  'specs/hal-engine-tool-responses/spec.md',
];

// docs/spikes/** is deliberately absent. A spike records what was believed when it
// was written, and its status block says which claims no longer hold; regenerating
// its code would falsify the record rather than repair it.

// example/ imports the source tree; a reader installs the package.
const IMPORT_REWRITES = [[/from '\.\.\/src\/index\.js'/g, "from '@re-cinq/hal-engine'"]];

// Every spelling a renderer treats as TypeScript, plus any info string after it: accepting only one
// spelling let a block keep its marker, stop being compared, and still render as code.
const TYPESCRIPT_FENCE = /^```[ \t]*(typescript|ts|tsx)\b[^`]*$/i;
const CLOSING_FENCE = /^```[ \t]*$/;

const args = process.argv.slice(2);
const fix = args.includes('--fix');
if (args.some(a => a !== '--fix')) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const read = path => readFileSync(join(root, path), 'utf8');
const trimEnd = text =>
  text
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

function declaration(path, name) {
  const source = read(path);
  const start = source.search(new RegExp(`^export (?:interface|type|class|function|const) ${name}\\b`, 'm'));
  if (start < 0) return {error: `no exported declaration named ${name} in ${path}`};

  const rest = source.slice(start);
  const firstBrace = rest.indexOf('{');
  const semicolon = rest.indexOf(';');

  // `type X = 'a' | 'b';` has no brace, so a bare semicolon terminates it.
  if (firstBrace < 0 || (semicolon >= 0 && semicolon < firstBrace)) {
    return {text: rest.slice(0, semicolon + 1).replace(/^export /, '')};
  }

  let depth = 0;
  for (let i = firstBrace; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1;
    if (rest[i] === '}') depth -= 1;
    if (depth === 0) return {text: rest.slice(0, i + 1).replace(/^export /, '')};
  }
  return {error: `unbalanced braces reading ${name} from ${path}`};
}

function region(path, name) {
  const lines = read(path).split('\n');
  const open = lines.findIndex(l => l.trim() === `// #region ${name}`);
  if (open < 0) return {error: `no "// #region ${name}" in ${path}`};

  const close = lines.findIndex((l, i) => i > open && l.trim() === '// #endregion');
  if (close < 0) return {error: `"// #region ${name}" in ${path} is never closed`};

  const body = lines.slice(open + 1, close);
  const indents = body.filter(l => l.trim()).map(l => l.match(/^ */)[0].length);
  const dedent = indents.length > 0 ? Math.min(...indents) : 0;
  let text = body.map(l => l.slice(dedent)).join('\n');
  for (const [pattern, replacement] of IMPORT_REWRITES) text = text.replace(pattern, replacement);
  return {text};
}

function expected(marker) {
  const [path, name] = marker.split('#');
  if (!path || !name) return {error: `marker "${marker}" is not path#name`};
  return path.startsWith('example/') ? region(path, name) : declaration(path, name);
}

const findings = [];
let rewritten = 0;

for (const doc of DOCS) {
  const lines = read(doc).split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (!TYPESCRIPT_FENCE.test(lines[i])) continue;

    const close = lines.findIndex((l, j) => j > i && CLOSING_FENCE.test(l));
    if (close < 0) {
      findings.push(`${doc}:${i + 1} typescript block is never closed`);
      continue;
    }
    const previous = (lines[i - 1] ?? '').trim();
    const match = previous.match(/^<!-- doc-block: (.+?) -->$/);

    if (!match) {
      findings.push(`${doc}:${i + 1} typescript block carries no doc-block marker`);
      continue;
    }

    const [optOut, reason] = match[1].split(' -- ');
    if (optOut === 'none') {
      if (!reason || !reason.trim()) findings.push(`${doc}:${i + 1} opt-out carries no reason`);
      continue;
    }

    const {text, error} = expected(match[1]);
    if (error) {
      findings.push(`${doc}:${i + 1} ${error}`);
      continue;
    }

    const actual = trimEnd(lines.slice(i + 1, close).join('\n'));
    if (actual === trimEnd(text)) continue;

    if (!fix) {
      findings.push(`${doc}:${i + 1} block does not match ${match[1]}`);
      continue;
    }

    lines.splice(i + 1, close - i - 1, ...trimEnd(text).split('\n'));
    changed = true;
    rewritten += 1;
  }

  if (changed) writeFileSync(join(root, doc), lines.join('\n'));
}

if (fix) {
  process.stdout.write(`check-doc-blocks: rewrote ${rewritten} block(s)\n`);
}

for (const finding of findings) process.stdout.write(`  ${finding}\n`);
process.stdout.write(`check-doc-blocks: ${findings.length} finding(s) across ${DOCS.length} documents\n`);
process.exit(findings.length > 0 ? 1 : 0);
