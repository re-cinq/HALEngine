import {sep} from 'node:path';
import {lintFixtures, messagesFor, type LintResult} from './helpers/eslint-fixtures.js';

// Judged by the committed markdown rules - see lintFixtures in helpers/eslint-fixtures.ts.
const fixtureDir = 'scripts/fixtures/spec-status';

const lint = (): LintResult[] =>
  lintFixtures([
    `${fixtureDir}/specs/no-lead/spec.md`,
    `${fixtureDir}/specs/untagged/spec.md`,
    `${fixtureDir}/specs/unreadable-status/spec.md`,
    `${fixtureDir}/specs/shipped-partial/spec.md`,
    `${fixtureDir}/specs/in-progress/spec.md`,
    `${fixtureDir}/specs/in-review-partial/spec.md`,
    `${fixtureDir}/specs/accepted-partial/spec.md`,
    `${fixtureDir}/specs/retired/spec.md`,
    `${fixtureDir}/specs/rejected/spec.md`,
    `${fixtureDir}/adrs/ADR-042-tide-ledger.md`,
    `${fixtureDir}/adrs/ADR-043-lamp-oil.md`,
  ]);

// Named, not prefix-matched: a prefix would collect every other re-lint rule too.
const UNDER_TEST = new Set(['re-lint/require-intro-paragraph', 're-lint/require-status-matches-coverage']);

const reLintMessages = (results: LintResult[], fixture: string) =>
  messagesFor(results, fixture).filter(m => m.ruleId !== null && UNDER_TEST.has(m.ruleId));

describe('the spec and ADR document lint guardrails', () => {
  let results: LintResult[];

  beforeAll(() => {
    results = lint();
  });

  it('a spec opening straight into a section fails with re-lint/require-intro-paragraph at line 1', () => {
    expect(reLintMessages(results, `no-lead${sep}spec.md`)).toMatchObject([
      {ruleId: 're-lint/require-intro-paragraph', line: 1},
    ]);
  });

  it('an ADR with no lead paragraph fails with re-lint/require-intro-paragraph', () => {
    expect(reLintMessages(results, 'ADR-043-lamp-oil.md')).toMatchObject([{ruleId: 're-lint/require-intro-paragraph'}]);
  });

  it('a spec with no status row fails with re-lint/require-status-matches-coverage as untagged', () => {
    expect(reLintMessages(results, `untagged${sep}spec.md`)).toMatchObject([
      {
        ruleId: 're-lint/require-status-matches-coverage',
        message: expect.stringContaining('declares no status the parsers can read'),
      },
    ]);
  });

  it('a spec whose status row reads "Banana" fails as untagged at that row\'s line', () => {
    expect(reLintMessages(results, `unreadable-status${sep}spec.md`)).toMatchObject([
      {ruleId: 're-lint/require-status-matches-coverage', line: 6},
    ]);
  });

  it('a spec tagged Shipped with one unlinked statement is told to set "In Progress"', () => {
    expect(reLintMessages(results, `shipped-partial${sep}spec.md`)).toMatchObject([
      {
        ruleId: 're-lint/require-status-matches-coverage',
        line: 6,
        message: expect.stringContaining('set the status to "In Progress"'),
      },
    ]);
  });

  it('a spec tagged "In Progress" with partial coverage passes both rules', () => {
    expect(reLintMessages(results, `in-progress${sep}spec.md`)).toEqual([]);
  });

  it('an accepted ADR with a lead paragraph and no test links passes: ADRs are exempt from the coverage tier', () => {
    expect(reLintMessages(results, 'ADR-042-tide-ledger.md')).toEqual([]);
  });

  it('a spec tagged "In Review" with partial coverage buckets in-progress and passes', () => {
    expect(reLintMessages(results, `in-review-partial${sep}spec.md`)).toEqual([]);
  });

  it('a spec tagged Accepted with partial coverage buckets shipped and is told to set "In Progress"', () => {
    expect(reLintMessages(results, `accepted-partial${sep}spec.md`)).toMatchObject([
      {
        ruleId: 're-lint/require-status-matches-coverage',
        message: expect.stringContaining('set the status to "In Progress"'),
      },
    ]);
  });

  it('a spec tagged Retired or Rejected passes with no statement linked: terminal buckets skip the tier', () => {
    expect({
      retired: reLintMessages(results, `retired${sep}spec.md`),
      rejected: reLintMessages(results, `rejected${sep}spec.md`),
    }).toEqual({retired: [], rejected: []});
  });
});
