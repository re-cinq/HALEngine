// Every fenced typescript block in a documented file is generated from source, not transcribed.

// Hand transcription is how the repo shipped a wrong frame order, a field name that
// never existed and three config keys that are not read. A marker names where a block
// comes from; --fix rewrites the block from there.

import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
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
  'specs/hal-engine-thinking-tag-parser/spec.md',
];

// A spike records what was believed when it was written, and its status block says which claims no
// longer hold. Its blocks are opted out wholesale rather than one marker at a time: the reason is
// the same for every block in the file, it is already written in the status block that
// check-spike-status.mjs requires, and 34 copies of it would be 34 places to drift. What is checked
// here is the opposite risk - a spike block wired to live source would regenerate spike code from
// the implementation that superseded it, quietly erasing the record.
const SPIKES = [
  'docs/spikes/adding-tool-evaluation.md',
  'docs/spikes/mcp.md',
  'docs/spikes/spike-ai-response-validation.md',
  'docs/spikes/spike-bedrock-integration.md',
];

// example/ imports the source tree; a reader installs the package.
const IMPORT_REWRITES = [[/from '\.\.\/src\/index\.js'/g, "from '@re-cinq/hal-engine'"]];

// Every spelling a renderer treats as TypeScript, plus any info string after it: accepting only one
// spelling let a block keep its marker, stop being compared, and still render as code. The fence is
// read as CommonMark writes it - three or more backticks or tildes, up to three spaces of indent,
// closed only by the same character at least as long - because four backticks, a tilde fence and a
// fence indented inside a list all render as code and all passed a gate that saw only ```.
const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(typescript|ts|tsx)\b[^`]*$/i;
const ANY_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const closes = (line, marker) => {
  const match = ANY_CLOSE.exec(line);
  return match !== null && match[1][0] === marker[0] && match[1].length >= marker.length;
};
const MARKER = /^<!-- doc-block: (.+?) -->$/;

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
let spikeBlocks = 0;

for (const doc of SPIKES) {
  const lines = read(doc).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    if (!OPEN_FENCE.test(lines[i])) continue;
    spikeBlocks += 1;

    const marker = (lines[i - 1] ?? '').trim().match(MARKER);
    if (marker && marker[1].split(' -- ')[0] !== 'none') {
      findings.push(`${doc}:${i} a spike block names a source; its code is the record, not the implementation`);
    }
  }
}

for (const doc of DOCS) {
  const lines = read(doc).split('\n');
  let changed = false;

  // Driven from the marker as well as the fence: widening the recognised set left the bypass open,
  // because relabelling a block ```js keeps the marker, stops the comparison, and still renders as code.
  for (let i = 0; i < lines.length; i += 1) {
    if (!MARKER.test(lines[i].trim())) continue;
    if (OPEN_FENCE.test(lines[i + 1] ?? '')) continue;
    findings.push(`${doc}:${i + 1} doc-block marker is not followed by a typescript fence`);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const fence = OPEN_FENCE.exec(lines[i]);
    if (!fence) continue;
    const [, indent, marker] = fence;

    const close = lines.findIndex((l, j) => j > i && closes(l, marker));
    if (close < 0) {
      findings.push(`${doc}:${i + 1} typescript block is never closed`);
      continue;
    }
    const previous = (lines[i - 1] ?? '').trim();
    const match = previous.match(MARKER);

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

    // A fence indented inside a list indents its content too; CommonMark strips up to that indent.
    const dedent = new RegExp(`^ {0,${indent.length}}`);
    const actual = trimEnd(
      lines
        .slice(i + 1, close)
        .map(l => l.replace(dedent, ''))
        .join('\n')
    );
    if (actual === trimEnd(text)) continue;

    if (!fix) {
      findings.push(`${doc}:${i + 1} block does not match ${match[1]}`);
      continue;
    }

    const generated = trimEnd(text)
      .split('\n')
      .map(l => (l ? indent + l : l));
    lines.splice(i + 1, close - i - 1, ...generated);
    changed = true;
    rewritten += 1;
  }

  if (changed) writeFileSync(join(root, doc), lines.join('\n'));
}

// A document in neither list is ungated, whatever it holds: the lists are hand-maintained, so a new
// guide with a typescript block was covered only if somebody remembered. Fixture documents are the
// other gates' inputs and say nothing about this package.
const covered = new Set([...DOCS, ...SPIKES]);
for (const doc of trackedMarkdown()) {
  if (covered.has(doc)) continue;
  if (!read(doc).split('\n').some(line => OPEN_FENCE.test(line))) continue;
  findings.push(`${doc} holds a typescript block but is in neither DOCS nor SPIKES of check-doc-blocks.mjs`);
}

if (fix) {
  process.stdout.write(`check-doc-blocks: rewrote ${rewritten} block(s)\n`);
}

for (const finding of findings) process.stdout.write(`  ${finding}\n`);
process.stdout.write(
  `check-doc-blocks: ${findings.length} finding(s) across ${DOCS.length} documents, plus ${spikeBlocks} block(s) in ${SPIKES.length} spikes\n`
);
process.exit(findings.length > 0 ? 1 : 0);

// Outside a repository there is nothing tracked, and so nothing ungated; the tests run in one.
function trackedMarkdown() {
  try {
    const out = execFileSync('git', ['ls-files', '*.md', ':!scripts/fixtures/**'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
