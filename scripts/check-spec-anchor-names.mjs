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
const DECLARATION = /^\s*(?:[fx])?(?:it|test|describe)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
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

    if (named === null) {
      if (!atLine) {
        findings.push(`${spec}: ${groups.path}#L${groups.line} is not a declaration, so no name can be read from it`);
        return whole;
      }
      if (!fix) {
        findings.push(`${spec}: ${groups.path}#L${groups.line} carries no test name`);
        return whole;
      }
      repaired += 1;
      changed = true;
      return citation(atLine.name, groups.path, atLine.line);
    }

    if (atLine && atLine.name === named) return whole;

    const matches = declarations.filter(declaration => declaration.name === named);
    if (matches.length === 0) {
      findings.push(`${spec}: names "${named}", which no declaration in ${groups.path} has`);
      return whole;
    }
    // A name declared more than once resolves to the nearest one: a citation goes stale by a line
    // shift, and the declaration a few lines from where it used to be is the one the author meant.
    const nearest = closestTo(Number(groups.line), matches);
    if (nearest === null) {
      findings.push(
        `${spec}: names "${named}", which ${groups.path} declares ${matches.length} times at equal distance`
      );
      return whole;
    }
    if (!fix) {
      findings.push(`${spec}: names "${named}" but points at #L${groups.line}; it is at #L${nearest.line}`);
      return whole;
    }
    repaired += 1;
    changed = true;
    return citation(named, groups.path, nearest.line);
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

// null when two candidates sit equally far from the cited line, which no shift produces.
function closestTo(line, matches) {
  const distance = match => Math.abs(match.line - line);
  const best = matches.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  const tied = matches.filter(match => distance(match) === distance(best));

  return tied.length === 1 ? best : null;
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
    return match ? [{line: index + 1, name: match[2]}] : [];
  });

  cache.set(path, found);
  return found;
}

function specs() {
  const out = execFileSync('git', ['ls-files', 'specs/**/*.md', 'adrs/*.md'], {cwd: root, encoding: 'utf8'});
  return out.trim().split('\n').filter(Boolean);
}
