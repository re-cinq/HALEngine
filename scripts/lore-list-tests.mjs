#!/usr/bin/env node
// Emits the Lore test-command `list` shape: a single JSON array of
// {id, name, file} objects, one per test, and nothing else on stdout.
// Jest cannot resolve test names without executing them - there is no
// dry-run - so the suite is run once with --json written to a temp file and
// progress sent to stderr, keeping stdout pure.
// The id is "<repo-relative-file>::<full test name>" - stable across runs,
// and exactly what the run command's {selector} splits back apart.
import {execFileSync} from 'node:child_process';
import {readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import process from 'node:process';

const reportFile = join(tmpdir(), `hal-engine-jest-report-${process.pid}.json`);

try {
  execFileSync('npx', ['jest', '--json', `--outputFile=${reportFile}`], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'inherit'],
    // The suite runs as ESM; jest needs the flag in every spawn, not just npm test.
    env: {...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --experimental-vm-modules`.trim()},
  });
} catch {
  // A failing test still produces a full report, and listing must not depend
  // on the suite being green. An unreadable report below is the real failure.
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

const tests = report.testResults.flatMap(suite => {
  const file = relative(process.cwd(), suite.name);

  return suite.assertionResults.map(assertion => ({
    id: `${file}::${assertion.fullName}`,
    name: assertion.fullName,
    file,
  }));
});

process.stdout.write(`${JSON.stringify(tests)}\n`);
