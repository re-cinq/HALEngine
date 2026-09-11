import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RunResult = { status: number | null; stdout: string; stderr: string };

export const runScript = (script: string, args: string[], { cwd }: { cwd: string }): RunResult => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

export const git = (repo: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
};

export const gitOut = (repo: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

export const writeInRepo = (repo: string, path: string, content: string): void => {
  mkdirSync(join(repo, dirname(path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

export const expectUsageError = (result: RunResult): void => {
  expect(result).toMatchObject({ status: 2 });
  expect(result.stderr).toContain("usage:");
};

export const scriptRunner = (script: string) => {
  const runFrom = (cwd: string, ...args: string[]): RunResult => runScript(script, args, { cwd });

  return { runFrom, run: (...args: string[]): RunResult => runFrom(process.cwd(), ...args) };
};
