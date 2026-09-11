#!/usr/bin/env node
// Runs exactly one test for the Lore test-command interface. The selector is
// "<repo-relative-file>::<full test name>" as emitted by lore-list-tests.mjs.
// Jest's -t flag is a regex matched against the full name, so the name is
// escaped and anchored - a name containing (parens) or {500} must match
// literally - and the file is passed with --runTestsByPath, which takes a path
// rather than the regex a bare positional argument would be.
// A selector that matches nothing is a failure, never a silently green run of
// an empty suite.
import {execFileSync} from 'node:child_process';
import {readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';

const selector = process.argv[2];

if (!selector || !selector.includes('::')) {
  process.stderr.write('usage: lore-run-test.mjs "<file>::<full test name>"\n');
  process.exit(2);
}

const separator = selector.indexOf('::');
const file = selector.slice(0, separator);
const name = selector.slice(separator + 2);
const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const reportFile = join(tmpdir(), `hal-engine-jest-run-${process.pid}.json`);

let runFailed = false;

try {
  execFileSync(
    'npx',
    [
      'jest',
      '--runTestsByPath',
      file,
      '-t',
      `^${escaped}$`,
      '--json',
      `--outputFile=${reportFile}`,
      '--coverage',
      '--coverageReporters=lcov',
    ],
    {cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit']}
  );
} catch {
  runFailed = true;
}

let report;

try {
  report = JSON.parse(readFileSync(reportFile, 'utf8'));
} catch (error) {
  process.stderr.write(`jest produced no readable report at ${reportFile}: ${error.message}\n`);
  process.exit(1);
} finally {
  rmSync(reportFile, {force: true});
}

// Every test in the file that -t did not select is reported as pending, so the
// count that matters is the ones actually executed.
const ran = report.numTotalTests - (report.numPendingTests ?? 0);

if (ran === 0) {
  process.stderr.write(`selector matched no test: ${selector}\n`);
  process.exit(1);
}

process.exit(runFailed || report.numFailedTests > 0 ? 1 : 0);
