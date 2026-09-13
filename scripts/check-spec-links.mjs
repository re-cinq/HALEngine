// Local counterpart of the Lore spec-coverage job that consumes these links: a `([validated by](...))`
// link only counts when it sits in its statement's trailing parenthetical, so a
// link anywhere else is reported here rather than silently dropped there.
// Segmentation and link parsing come from the published spec domain
// of @re-cinq/eslint-plugin-re-lint (AGENTS.md § Spec Test Links).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { findMisplacedCoverageLinks } from "@re-cinq/eslint-plugin-re-lint/spec/spec-link-parser.js";
import { segmentStatements } from "@re-cinq/eslint-plugin-re-lint/spec/spec-segment.js";
import { root } from "./lib/repo-root.mjs";

const USAGE =
  "usage: check-spec-links.mjs [--json] [spec-path ...]\n" +
  "spec paths resolve against the repo root, not the working directory; an absolute path is taken as given";

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("--"));
const specArgs = args.filter((arg) => !arg.startsWith("--"));

for (const flag of flags) {
  if (flag === "--json") {
    continue;
  }
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const asJson = flags.includes("--json");

const discoverSpecs = () => {
  const specsDir = join(root, "specs");
  const slugs = readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return [...slugs.map((slug) => `specs/${slug}/spec.md`), ".specify/spec.md"];
};

const specPaths =
  specArgs.length > 0
    ? specArgs.map((path) => relative(root, resolve(root, path)))
    : discoverSpecs();

const readSpec = (specPath) => {
  try {
    return readFileSync(join(root, specPath), "utf8");
  } catch (error) {
    process.stderr.write(`cannot read spec ${specPath}: ${error.message}\n`);
    process.exit(2);
  }
};

const findings = [];
const specsWithFindings = new Set();
let statementsScanned = 0;

for (const specPath of specPaths) {
  const content = readSpec(specPath);

  for (const statement of segmentStatements(content)) {
    statementsScanned += 1;

    for (const link of findMisplacedCoverageLinks(statement.text)) {
      findings.push({
        spec: specPath,
        line: statement.line ?? null,
        path: link.path,
        anchorLine: link.line,
        label: link.label,
        statement: statement.text,
      });
      specsWithFindings.add(specPath);
    }
  }
}

const reportLines = () => {
  const lines = findings.map((finding) => {
    const anchor = finding.anchorLine === null ? "" : `#L${finding.anchorLine}`;
    const line = finding.line ?? "?";

    return `${finding.spec}:${line}: ${finding.path}${anchor} cited outside the statement's trailing parenthetical`;
  });

  lines.push(
    `misplaced: ${findings.length} across ${specsWithFindings.size} specs (${statementsScanned} statements scanned)`
  );

  return lines;
};

// process.exitCode, not process.exit: exiting truncates a large stdout write
// to a pipe.
process.exitCode = findings.length > 0 ? 1 : 0;
process.stdout.write(
  asJson ? `${JSON.stringify(findings, null, 2)}\n` : `${reportLines().join("\n")}\n`
);
