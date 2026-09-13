#!/usr/bin/env node
// Holds every `([validated by: <test name>](path#Lnn))` citation to the test it names.
//
// Usage:
//   node scripts/check-spec-anchor-names.mjs           # report, exit 1 on any finding
//   node scripts/check-spec-anchor-names.mjs --fix     # repoint each line from the name it carries
//
// A line number is the wrong thing to cite: inserting an import above a suite moves every test below
// it, and the citation silently lands on a different, still-valid declaration. The name is what the
// author meant, so the name is what the citation records and the line becomes a derived pointer this
// script repairs. The `#Lnn` stays because the lint rule and the coverage job both index by it, and a
// citation without one marks the whole file covered rather than one test.
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import process from 'node:process';
import {dirname, join, normalize} from 'node:path';
import {root} from './lib/repo-root.mjs';

const CITATION = /\[validated by(?<label>: [^\]]*)?\]\((?<path>(?:\.\.\/)+[\w./-]+?)#L(?<line>\d+)\)/g;
// Any other href shape is refused rather than ignored: the coverage job resolves `./../x` and `/x`
// to the same file and counts them, while this gate and the drift check would never have read them.
const ANY_HREF = /\[validated by(?:: [^\]]*)?\]\((?<path>[^)#\s]+)#L\d+\)/g;
// `xit`, `xdescribe` and `.skip` declare a test that never runs, which validates nothing.
const DECLARATION = /^\s*(?:f?it|f?describe|test)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
const SKIPPED = /^\s*(?:x(?:it|describe|test)|(?:it|describe|test)\.skip)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const cache = new Map();
const args = process.argv.slice(2);
const fix = args.includes('--fix');
const named = args.filter(arg => !arg.startsWith('--'));
const findings = [];
let checked = 0;
let repaired = 0;

for (const spec of named.length > 0 ? named : specs()) {
  const source = readFileSync(join(root, spec), 'utf8');
  const specDir = dirname(spec);
  let changed = false;

  for (const match of source.matchAll(ANY_HREF)) {
    if (!match.groups.path.startsWith('../')) {
      findings.push(`${spec}: href "${match.groups.path}" must be relative and start with ../`);
    }
  }

  const rewritten = source.replace(CITATION, (whole, label, path, line, ...rest) => {
    const groups = rest[rest.length - 1];
    const target = normalize(join(specDir, groups.path));
    if (!TEST_FILE.test(target)) return whole;

    checked += 1;
    const declarations = declarationsIn(target);
    if (declarations === null) {
      findings.push(`${spec}: ${groups.path} does not exist`);
      return whole;
    }

    const named = groups.label ? groups.label.slice(2) : null;
    const atLine = declarations.find(declaration => declaration.line === Number(groups.line));

    const skipped = declarations.find(d => d.skipped && (d.name === named || d.line === Number(groups.line)));
    if (skipped) {
      findings.push(`${spec}: cites "${skipped.name}" at ${groups.path}#L${skipped.line}, which is skipped and validates nothing`);
      return whole;
    }

    if (named === null) {
      if (!atLine) {
        findings.push(`${spec}: ${groups.path}#L${groups.line} is not a declaration, so no name can be read from it`);
        return whole;
      }
      if (nameIsAmbiguous(declarations, atLine.name)) {
        findings.push(ambiguity(spec, groups.path, atLine.name, declarations));
        return whole;
      }
      if (!fix) {
        findings.push(`${spec}: ${groups.path}#L${groups.line} carries no test name`);
        return whole;
      }
      return rewrite(atLine.name, groups.path, atLine.line);
    }

    // Checked before the line is consulted: a name that identifies two declarations is not an
    // identifier, and while the line happens to agree nothing would ever say so.
    if (nameIsAmbiguous(declarations, named)) {
      findings.push(ambiguity(spec, groups.path, named, declarations));
      return whole;
    }

    if (atLine && atLine.name === named) return whole;

    const [match] = declarations.filter(declaration => declaration.name === named);
    if (!match) {
      findings.push(`${spec}: names "${named}", which no declaration in ${groups.path} has`);
      return whole;
    }
    if (!fix) {
      findings.push(`${spec}: names "${named}" but points at #L${groups.line}; it is at #L${match.line}`);
      return whole;
    }
    return rewrite(named, groups.path, match.line);

    function rewrite(name, path, line) {
      // A name carrying a bracket would close the markdown label early: the citation stops being a
      // link, stops matching CITATION, and disappears from this gate and from the coverage job.
      if (/[[\]]/.test(name)) {
        findings.push(`${spec}: "${name}" carries a bracket and cannot be written into a markdown label`);
        return whole;
      }
      repaired += 1;
      changed = true;
      return citation(name, path, line);
    }
  });

  if (changed) writeFileSync(join(root, spec), rewritten);
}

for (const finding of findings) process.stderr.write(`check-spec-anchor-names: ${finding}\n`);

if (findings.length > 0) {
  process.stderr.write(`\ncheck-spec-anchor-names: ${findings.length} finding(s).\n`);
  process.stderr.write('Run `npm run spec:names -- --fix` to repoint a citation from the name it carries.\n');
  process.exit(1);
}

const verb = fix ? `repointed ${repaired},` : '';
process.stdout.write(`check-spec-anchor-names: ${verb} ${checked} citation(s) name the test they point at\n`);

function nameIsAmbiguous(declarations, name) {
  return declarations.filter(declaration => declaration.name === name && !declaration.skipped).length > 1;
}

function ambiguity(spec, path, name, declarations) {
  const lines = declarations.filter(declaration => declaration.name === name).map(d => `#L${d.line}`);
  return `${spec}: "${name}" names ${lines.length} declarations in ${path} (${lines.join(', ')}) — rename one`;
}

function citation(name, path, line) {
  return `[validated by: ${name}](${path}#L${line})`;
}

function declarationsIn(path) {
  if (cache.has(path)) return cache.get(path);

  let lines;
  try {
    lines = readFileSync(join(root, path), 'utf8').split('\n');
  } catch {
    cache.set(path, null);
    return null;
  }
  const found = lines.flatMap((text, index) => {
    const match = DECLARATION.exec(text);
    if (match) return [{line: index + 1, name: match[2], skipped: false}];
    const skipped = SKIPPED.exec(text);
    return skipped ? [{line: index + 1, name: skipped[2], skipped: true}] : [];
  });

  cache.set(path, found);
  return found;
}

function specs() {
  const out = execFileSync('git', ['ls-files', 'specs/**/*.md', 'adrs/*.md'], {cwd: root, encoding: 'utf8'});
  return out.trim().split('\n').filter(Boolean);
}
