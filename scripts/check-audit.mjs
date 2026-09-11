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
const found = collectFindings(audit);

const {accepted, problems} = readAcceptances();
const key = finding => `${finding.advisory}::${finding.name}`;
const unacknowledged = found.filter(finding => !accepted.has(key(finding)));
const unused = [...accepted.values()].filter(
  entry => !found.some(finding => finding.name === entry.package && finding.advisory === entry.advisory)
);

for (const problem of problems) fail(problem);
for (const entry of unused)
  fail(`acceptance for ${entry.advisory} in "${entry.package}" matches no current advisory — remove it`);
for (const finding of unacknowledged) fail(describeFinding(finding));

if (problems.length || unused.length || unacknowledged.length) {
  process.stderr.write(`\ncheck-audit: ${problems.length + unused.length + unacknowledged.length} finding(s).\n`);
  process.stderr.write(`Fix with \`npm audit fix\`, or record an acceptance in ${ACCEPTANCES}.\n`);
  process.exit(1);
}

const counts = audit.metadata?.vulnerabilities ?? {};
process.stdout.write(`check-audit: clean at high and above (${describe(counts)}), ${accepted.size} acceptance(s).\n`);

function runAudit() {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--json'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  } catch (error) {
    // npm audit exits non-zero when it finds anything; the report is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.trim()) raw = error.stdout;
    else return abort(`npm audit produced no readable report: ${error.message}`);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    return abort(`npm audit did not return JSON: ${error.message}`);
  }

  // A registry failure is also JSON, and carries no `vulnerabilities` key. Without this the
  // gate reads "nothing reported" as "nothing wrong" and a release ships unaudited.
  if (!report || typeof report !== 'object' || !isReport(report)) {
    return abort(`npm audit returned no vulnerability report (keys: ${Object.keys(report ?? {}).join(', ')})`);
  }

  return report;
}

function isReport(report) {
  return typeof report.vulnerabilities === 'object' || typeof report.metadata?.vulnerabilities === 'object';
}

function abort(message) {
  process.stderr.write(`check-audit: ${message}\n`);
  process.stderr.write('check-audit: refusing to report clean on a report it could not read.\n');
  process.exit(1);
}

// One finding per (package, advisory): an acceptance names one advisory, so a second advisory in
// the same package has to arrive as its own finding rather than hiding behind the first.
function collectFindings(audit) {
  const vulnerabilities = audit.vulnerabilities ?? {};
  const findings = [];

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (!FAIL_AT.includes(vulnerability.severity)) continue;

    for (const advisory of advisoriesFor(name, vulnerabilities)) {
      findings.push({
        name,
        severity: vulnerability.severity,
        range: vulnerability.range ?? 'unknown range',
        through: reachedThrough(name, vulnerability),
        advisory: advisory.id,
        title: advisory.title,
      });
    }
  }

  return findings;
}

// A transitive entry's `via` names packages rather than advisories, so the ids come from following it.
function advisoriesFor(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);

  const via = vulnerabilities[name]?.via ?? [];
  const own = via
    .filter(entry => typeof entry === 'object')
    .map(entry => ({id: advisoryId(entry), title: entry.title}));
  const inherited = via
    .filter(entry => typeof entry === 'string')
    .flatMap(dep => advisoriesFor(dep, vulnerabilities, seen));
  const all = [...own, ...inherited];

  return all.length > 0 ? all : [{id: `unknown:${name}`, title: 'advisory id absent from the report'}];
}

// The GHSA id is in the advisory URL; `source` is npm's own numeric id and is the fallback.
function advisoryId(entry) {
  const ghsa = /GHSA-[0-9a-z-]+/i.exec(entry.url ?? '');
  return ghsa ? ghsa[0] : `npm:${entry.source ?? 'unknown'}`;
}

function reachedThrough(name, vulnerability) {
  if (vulnerability.isDirect) return 'a direct dependency';
  const effects = (vulnerability.effects ?? []).join(', ');
  return effects ? `reached through ${effects}` : 'reached through an undisclosed path';
}

function describeFinding(finding) {
  return `${finding.severity}: ${finding.name}@${finding.range} ${finding.advisory} — ${finding.title}, ${finding.through}`;
}

function readAcceptances() {
  if (!existsSync(ACCEPTANCES)) return {accepted: new Map(), problems: []};

  let entries;
  try {
    entries = JSON.parse(readFileSync(ACCEPTANCES, 'utf8'));
  } catch (error) {
    return {accepted: new Map(), problems: [`${ACCEPTANCES} is not valid JSON: ${error.message}`]};
  }
  if (!Array.isArray(entries)) return {accepted: new Map(), problems: [`${ACCEPTANCES} must hold an array`]};

  const accepted = new Map();
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
      problems.push(
        `acceptance for ${entry.advisory} in "${entry.package}" expired ${entry.expires} — recheck it or renew it`
      );
      continue;
    }
    // Keyed on the pair: an acceptance covers the advisory it names and nothing else in that package.
    accepted.set(`${entry.advisory}::${entry.package}`, entry);
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
