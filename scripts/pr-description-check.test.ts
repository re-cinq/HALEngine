import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseDocument} from 'yaml';
import {root} from './lib/repo-root.mjs';

type Job = {if?: string; steps: {run: string; if?: string}[]};

const job = (): Job => {
  const workflow = parseDocument(readFileSync(join(root, '.github/workflows/pr-description-check.yml'), 'utf8')).toJS();

  return (workflow as {jobs: Record<string, Job>}).jobs['check-pr-description'];
};

const checkBody = (body: string) => {
  const [step] = job().steps;
  const {status, stdout} = spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: {...process.env, PR_BODY: body},
  });

  return {status, stdout};
};

describe('the pull request description check', () => {
  it('skips a pull request Dependabot opened, by its author rather than whoever edits it', () => {
    expect({condition: job().if, stepConditions: job().steps.map(step => 'if' in step)}).toEqual({
      condition: "github.event.pull_request.user.login != 'dependabot[bot]'",
      stepConditions: [false],
    });
  });

  it('still passes a body with all three headings and fails a Dependabot-style one, naming each it lacks', () => {
    expect({
      complete: checkBody('## Why\n\nA.\n\n## What Changed\n\nB.\n\n## Testing\n\nC.\n'),
      dependabotStyle: checkBody('Bumps [@types/node](https://github.com/DefinitelyTyped) from 26.6.5 to 26.6.6.\n'),
    }).toEqual({
      complete: {status: 0, stdout: 'All required PR description sections are present.\n'},
      dependabotStyle: {
        status: 1,
        stdout:
          '::error::PR description is missing required sections: ## Why ## What Changed ## Testing\n' +
          'Required sections: ## Why, ## What Changed, ## Testing\n',
      },
    });
  });
});
