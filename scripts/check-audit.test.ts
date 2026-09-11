import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The gate runs immediately before `npm publish`, so both of its red branches are the contract.

const script = join(process.cwd(), "scripts", "check-audit.mjs");

type RunResult = { status: number | null; stdout: string; stderr: string };

const workspaces: string[] = [];

// A stub `npm` on PATH: the script shells out, so this is the only seam that controls the report.
const workspace = (auditStdout: string, auditExit = 1): string => {
  const dir = mkdtempSync(join(tmpdir(), "check-audit-"));
  workspaces.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "npm");
  writeFileSync(stub, `#!/bin/sh\ncat <<'REPORT'\n${auditStdout}\nREPORT\nexit ${auditExit}\n`);
  chmodSync(stub, 0o755);
  return dir;
};

const accept = (dir: string, entries: unknown[]): void => {
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(join(dir, ".github", "audit-acknowledgements.json"), JSON.stringify(entries));
};

const run = (dir: string): RunResult => {
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const advisory = (id: string, severity: string, title: string) => ({
  source: 1,
  name: "left-pad",
  title,
  url: `https://github.com/advisories/${id}`,
  severity,
});

const report = (via: unknown[]) =>
  JSON.stringify({
    vulnerabilities: {
      "left-pad": { name: "left-pad", severity: "critical", isDirect: true, via, range: "<1.3.0", effects: [] },
    },
    metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0 } },
  });

const CRITICAL = report([advisory("GHSA-9999-9999-9999", "critical", "Remote code execution")]);

const future = "2099-01-01";
const entry = (id: string) => ({
  advisory: id,
  package: "left-pad",
  why: "triaged, not reachable from this package",
  expires: future,
  // eslint-disable-next-line camelcase -- the acknowledgement file's own field name, fixed by check-audit.mjs
  acknowledged_by: "a maintainer",
});

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe("check-audit on a report it cannot read", () => {
  it("refuses to report clean when npm returns its registry-failure document", () => {
    const dir = workspace(JSON.stringify({ error: { code: "E401", summary: "Unauthorized" } }));

    expect(run(dir)).toMatchObject({ status: 1 });
  });

  it("names the reason rather than failing silently", () => {
    const dir = workspace(JSON.stringify({ error: { code: "E401", summary: "Unauthorized" } }));

    expect(run(dir).stderr).toContain("returned no vulnerability report");
  });

  it("refuses to report clean when npm returns no JSON at all", () => {
    const dir = workspace("npm ERR! network timeout");

    expect(run(dir)).toMatchObject({ status: 1 });
  });
});

describe("check-audit acceptances", () => {
  it("fails on an unacknowledged critical advisory", () => {
    expect(run(workspace(CRITICAL))).toMatchObject({ status: 1 });
  });

  it("names the package, version range, advisory id and path in the blocking line", () => {
    const { stderr } = run(workspace(CRITICAL));

    expect(stderr).toContain("critical: left-pad@<1.3.0 GHSA-9999-9999-9999 — Remote code execution, a direct dependency");
  });

  it("passes when the acceptance names that advisory", () => {
    const dir = workspace(CRITICAL);
    accept(dir, [entry("GHSA-9999-9999-9999")]);

    expect(run(dir)).toMatchObject({ status: 0 });
  });

  it("does not let an acceptance for one advisory cover a different one in the same package", () => {
    const dir = workspace(CRITICAL);
    accept(dir, [entry("GHSA-1111-1111-1111")]);

    expect(run(dir)).toMatchObject({ status: 1 });
  });

  it("reports the unmatched acceptance as stale rather than ignoring it", () => {
    const dir = workspace(CRITICAL);
    accept(dir, [entry("GHSA-1111-1111-1111")]);

    expect(run(dir).stderr).toContain('acceptance for GHSA-1111-1111-1111 in "left-pad" matches no current advisory');
  });

  it("fails on an acceptance whose expiry has passed", () => {
    const dir = workspace(CRITICAL);
    accept(dir, [{ ...entry("GHSA-9999-9999-9999"), expires: "2020-01-01" }]);

    expect(run(dir)).toMatchObject({ status: 1 });
  });

  it("names the expired acceptance by advisory and package", () => {
    const dir = workspace(CRITICAL);
    accept(dir, [{ ...entry("GHSA-9999-9999-9999"), expires: "2020-01-01" }]);

    expect(run(dir).stderr).toContain('acceptance for GHSA-9999-9999-9999 in "left-pad" expired 2020-01-01');
  });

  it("still fails on a second unacknowledged advisory in an otherwise accepted package", () => {
    const dir = workspace(
      report([
        advisory("GHSA-1111-1111-1111", "critical", "Prototype pollution"),
        advisory("GHSA-9999-9999-9999", "critical", "Remote code execution"),
      ])
    );
    accept(dir, [entry("GHSA-1111-1111-1111")]);

    expect(run(dir).stderr).toContain("GHSA-9999-9999-9999");
  });

  it("passes a clean report with no acceptances", () => {
    const dir = workspace(
      JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
      0
    );

    expect(run(dir)).toMatchObject({ status: 0 });
  });
});
