import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptRunner } from "./helpers/script-runner.js";

const root = process.cwd();
const script = join(root, "scripts", "check-spec-links.mjs");

const trailingSpec = "scripts/fixtures/spec-links/trailing/spec.md";
const misplacedSpec = "scripts/fixtures/spec-links/misplaced/spec.md";
const citedTest = "../../../../tests/check-at-pass.test.ts";
const trailingZeroSummary = "misplaced: 0 across 0 specs (9 statements scanned)\n";

type Finding = {
  spec: string;
  line: number | null;
  path: string;
  anchorLine: number | null;
  label: string;
  statement: string;
};

const { run, runFrom } = scriptRunner(script);

const findings = (...args: string[]): Finding[] => JSON.parse(run("--json", ...args).stdout);

const discoveredSpecs = (): string[] => {
  const slugs = readdirSync(join(root, "specs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return [...slugs.map((slug) => `specs/${slug}/spec.md`), ".specify/spec.md"];
};

describe("check-spec-links", () => {
  it("a list item with two mid-item citations reports both at the item's line", () => {
    expect(findings(misplacedSpec).filter((finding) => finding.line === 10)).toMatchObject([
      { anchorLine: 14, path: citedTest },
      { anchorLine: 22, path: citedTest },
    ]);
  });

  it("a mid-sentence citation in a paragraph reports one finding at the paragraph's line", () => {
    expect(findings(misplacedSpec).filter((finding) => finding.line === 16)).toMatchObject([
      {
        anchorLine: 38,
        statement:
          "The lamp turns clockwise " +
          "([validated by](../../../../tests/check-at-pass.test.ts#L38)) once every minute.",
      },
    ]);
  });

  it("a citation with no #L anchor is reported with the path alone", () => {
    expect(run(misplacedSpec).stdout).toContain(
      `${misplacedSpec}:20: ${citedTest} cited outside the statement's trailing parenthetical`
    );
  });

  it("a paragraph sentence whose citation is trailing reports nothing", () => {
    expect(run(trailingSpec).stdout).toBe(trailingZeroSummary);
  });

  it("a mid-sentence link to a script rather than a test reports nothing", () => {
    expect(run(trailingSpec).stdout).toBe(trailingZeroSummary);
  });

  it("a citation written inside backticks reports nothing", () => {
    expect(run(trailingSpec).stdout).toBe(trailingZeroSummary);
  });

  it("a spec citing only in trailing parentheticals exits 0 with a zero summary", () => {
    const result = run(trailingSpec);

    expect(result).toMatchObject({ status: 0, stdout: trailingZeroSummary });
  });

  it("a spec with misplaced citations exits 1 and summarises findings, specs and statements", () => {
    const result = run(misplacedSpec, trailingSpec);

    expect(result).toMatchObject({
      status: 1,
      stdout: expect.stringContaining("misplaced: 4 across 1 specs (17 statements scanned)"),
    });
  });

  it("--json prints only an array of findings carrying every reported field", () => {
    const result = run("--json", misplacedSpec);

    expect({ summarised: result.stdout.includes("misplaced:"), first: JSON.parse(result.stdout)[0] }).toEqual({
      summarised: false,
      first: {
        spec: misplacedSpec,
        line: 10,
        path: citedTest,
        anchorLine: 14,
        label: "validated by",
        statement: expect.stringContaining("The beacon clamps its range"),
      },
    });
  });

  it("an unknown flag exits 2 with the usage line", () => {
    const result = run("--frobnicate");

    expect(result).toMatchObject({
      status: 2,
      stdout: "",
      stderr: expect.stringContaining("usage: check-spec-links.mjs [--json] [spec-path ...]"),
    });
  });

  it("the usage line says paths resolve against the repo root", () => {
    expect(run("--frobnicate").stderr).toContain(
      "spec paths resolve against the repo root, not the working directory"
    );
  });

  it("a spec path that cannot be read exits 2 naming the path", () => {
    const result = run("scripts/fixtures/spec-links/absent/spec.md");

    expect(result).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("cannot read spec scripts/fixtures/spec-links/absent/spec.md"),
    });
  });

  it("a relative spec path resolves against the repo root, not the working directory", () => {
    expect(runFrom(tmpdir(), misplacedSpec)).toMatchObject({
      status: 1,
      stdout: run(misplacedSpec).stdout,
    });
  });

  it("an absolute spec path is scanned and reported repo-relative", () => {
    expect(runFrom(tmpdir(), join(root, misplacedSpec))).toMatchObject({
      status: 1,
      stdout: run(misplacedSpec).stdout,
    });
  });

  it("no spec paths scans the sorted specs directories plus .specify/spec.md", () => {
    expect(run().stdout).toBe(run(...discoveredSpecs()).stdout);
  });
});
