// Local counterpart of the ADR half of require-status-matches-coverage:
// an ADR must declare a lifecycle status the parsers can read, while staying
// exempt from the coverage tier that rule would also demand of it. Specs are
// gated in eslint.config.mjs by re-lint/require-intro-paragraph and
// re-lint/require-status-matches-coverage; the statement-link report behind
// --coverage is never a gate (AGENTS.md § Spec Header Table).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { parseDocStatus } from "@re-cinq/eslint-plugin-re-lint/spec/spec-status.js";
import { unlinkedTestableStatements } from "@re-cinq/eslint-plugin-re-lint/spec/spec-status-coverage.js";
import { root } from "./lib/repo-root.mjs";

const USAGE =
  "usage: check-spec-status.mjs [--coverage] [--json] [doc-path ...]\n" +
  "doc paths resolve against the repo root, not the working directory; an absolute path is taken as given";

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const docArgs = args.filter((arg) => !arg.startsWith("--"));

const usageExit = () => {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
};

for (const flag of flags) {
  if (flag === "--json" || flag === "--coverage") {
    continue;
  }
  usageExit();
}

const asJson = flags.includes("--json");
const asCoverage = flags.includes("--coverage");

const markdownIn = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();

const specDocs = () =>
  readdirSync(join(root, "specs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `specs/${entry.name}/spec.md`)
    .sort();

const discoverDocs = () => [...specDocs(), ...markdownIn("adrs")];

const docPaths =
  docArgs.length > 0 ? docArgs.map((path) => relative(root, resolve(root, path))) : discoverDocs();

const readDoc = (docPath) => {
  try {
    return readFileSync(join(root, docPath), "utf8");
  } catch (error) {
    process.stderr.write(`cannot read doc ${docPath}: ${error.message}\n`);
    process.exit(2);
  }
};

// The corpus folders the rules assume by default, matched at any depth so fixtures qualify.
const docKind = (docPath) => {
  if (/(^|\/)specs\//.test(docPath)) {
    return "spec";
  }

  return /(^|\/)adrs\//.test(docPath) ? "adr" : null;
};

// The frontmatter line a human has to edit, or the top of the file when there is none.
const frontmatterStatusLine = (content) => {
  const index = content.split(/\r?\n/).findIndex((line) => /^status\s*:/i.test(line));

  return index === -1 ? 1 : index + 1;
};

const adrStatusFindings = (docPath, content) => {
  if (parseDocStatus(content, "adr").status !== null) {
    return [];
  }

  return [
    {
      doc: docPath,
      line: frontmatterStatusLine(content),
      kind: "untagged",
      message: "no lifecycle status the parsers can read",
    },
  ];
};

const EXCERPT = 80;

const coverageFindings = (docPath, content) =>
  unlinkedTestableStatements(content).map((statement) => ({
    doc: docPath,
    line: statement.line,
    kind: "unlinked",
    message: `unlinked testable statement: ${statement.text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, EXCERPT)}`,
  }));

const findingsFor = (docPath, content, kind) => {
  if (asCoverage) {
    return coverageFindings(docPath, content);
  }

  return kind === "adr" ? adrStatusFindings(docPath, content) : [];
};

const findings = [];
const docsWithFindings = new Set();

for (const docPath of docPaths) {
  const content = readDoc(docPath);
  const kind = docKind(docPath);

  if (kind === null) {
    process.stderr.write(`check-spec-status.mjs: ${docPath} is neither a spec nor an ADR\n`);
    process.exit(2);
  }
  const found = findingsFor(docPath, content, kind);

  findings.push(...found);

  if (found.length > 0) {
    docsWithFindings.add(docPath);
  }
}

const summary = () => {
  const label = asCoverage ? "spec-coverage" : "spec-status";
  const counted = asCoverage
    ? `${findings.length} unlinked testable statements`
    : `${findings.length} findings`;

  return `${label}: ${counted} across ${docsWithFindings.size} docs (${docPaths.length} scanned)`;
};

const reportLines = () => [
  ...findings.map((finding) => `${finding.doc}:${finding.line}: ${finding.message}`),
  summary(),
];

// process.exitCode, not process.exit: exiting truncates a large piped write.
process.exitCode = asCoverage || findings.length === 0 ? 0 : 1;
process.stdout.write(
  asJson ? `${JSON.stringify(findings, null, 2)}\n` : `${reportLines().join("\n")}\n`
);
