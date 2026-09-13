import {spawnSync} from 'node:child_process';
import {resolve, sep} from 'node:path';

export interface LintMessage {
  ruleId: string | null;
  message: string;
  line: number;
}

export interface LintResult {
  filePath: string;
  messages: LintMessage[];
}

// --no-ignore lifts the fixtures' global ignore, so the committed rules judge them, not a copy.
export const lintFixtures = (fixtures: string[]): LintResult[] => {
  const result = spawnSync(
    'node',
    [resolve(process.cwd(), 'node_modules/eslint/bin/eslint.js'), '--no-ignore', '--format', 'json', ...fixtures],
    {cwd: process.cwd(), encoding: 'utf8'}
  );

  expect(result.status).toBe(1);

  return JSON.parse(result.stdout) as LintResult[];
};

export const messagesFor = (results: LintResult[], fixture: string): LintMessage[] => {
  const match = results.find(entry => entry.filePath.endsWith(`${sep}${fixture}`));

  if (!match) {
    throw new Error(`eslint reported nothing for ${fixture}`);
  }

  return match.messages;
};
