#!/usr/bin/env node
// Fails on any advisory at `high` or above that no committed acceptance covers.
// Deliberately audits the FULL tree, dev included: those packages are what a
// runner installs before building dist/, and after the release workflow lands
// that runner holds id-token: write and signs what it produces.
//
// Usage:
//   node scripts/check-audit.mjs
//
// An acceptance lives in .github/audit-acknowledgements.json and carries
// advisory, package, why, expires (ISO date) and acknowledged_by. An entry that
// is expired, malformed, or matches nothing in the current audit fails too - a
// stale acceptance is a claim nobody has rechecked.
import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync} from 'node:fs';

const FAIL_AT = ['high', 'critical'];
const ACCEPTANCES = '.github/audit-acknowledgements.json';
const REQUIRED_FIELDS = ['advisory', 'package', 'why', 'expires', 'acknowledged_by'];

const audit = runAudit();
const found = Object.entries(audit.vulnerabilities ?? {})
  .filter(([, v]) => FAIL_AT.includes(v.severity))
  .map(([name, v]) => ({name, severity: v.severity, via: titles(v)}));

const {accepted, problems} = readAcceptances();
const unacknowledged = found.filter(f => !accepted.has(f.package ?? f.name));
const unused = [...accepted].filter(pkg => !found.some(f => f.name === pkg));

for (const problem of problems) fail(problem);
for (const pkg of unused) fail(`acceptance for "${pkg}" matches no current advisory — remove it`);
for (const f of unacknowledged) fail(`${f.severity}: ${f.name} — ${f.via.join('; ') || 'no title'}`);

if (problems.length || unused.length || unacknowledged.length) {
  process.stderr.write(`\ncheck-audit: ${problems.length + unused.length + unacknowledged.length} finding(s).\n`);
  process.stderr.write(`Fix with \`npm audit fix\`, or record an acceptance in ${ACCEPTANCES}.\n`);
  process.exit(1);
}

const counts = audit.metadata?.vulnerabilities ?? {};
process.stdout.write(`check-audit: clean at high and above (${describe(counts)}), ${accepted.size} acceptance(s).\n`);

function runAudit() {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}));
  } catch (error) {
    // npm audit exits non-zero when it finds anything; the report is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    process.stderr.write(`check-audit: npm audit produced no readable report: ${error.message}\n`);
    process.exit(1);
  }
}

function titles(vulnerability) {
  return (vulnerability.via ?? []).map(v => (typeof v === 'string' ? v : v.title)).filter(Boolean);
}

function readAcceptances() {
  if (!existsSync(ACCEPTANCES)) return {accepted: new Set(), problems: []};

  let entries;
  try {
    entries = JSON.parse(readFileSync(ACCEPTANCES, 'utf8'));
  } catch (error) {
    return {accepted: new Set(), problems: [`${ACCEPTANCES} is not valid JSON: ${error.message}`]};
  }
  if (!Array.isArray(entries)) return {accepted: new Set(), problems: [`${ACCEPTANCES} must hold an array`]};

  const accepted = new Set();
  const problems = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const [index, entry] of entries.entries()) {
    const missing = REQUIRED_FIELDS.filter(f => !entry?.[f]);
    if (missing.length) {
      problems.push(`${ACCEPTANCES}[${index}] is missing ${missing.join(', ')}`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      problems.push(`${ACCEPTANCES}[${index}] expires "${entry.expires}" is not an ISO date`);
      continue;
    }
    if (entry.expires < today) {
      problems.push(`acceptance for "${entry.package}" expired ${entry.expires} — recheck it or renew it`);
      continue;
    }
    accepted.add(entry.package);
  }

  return {accepted, problems};
}

function describe(counts) {
  const parts = ['critical', 'high', 'moderate', 'low'].filter(k => counts[k]).map(k => `${counts[k]} ${k}`);
  return parts.length ? parts.join(', ') : 'nothing reported';
}

function fail(message) {
  process.stderr.write(`check-audit: ${message}\n`);
}
