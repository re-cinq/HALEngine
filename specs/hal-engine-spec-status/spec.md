# HAL Engine spec status

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

A spec that opens straight into a metadata table gives a reader nothing to orient on, and a status row a human last touched six sweeps ago says more about that human than about the spec. This file carries the header table convention, the lifecycle rule behind its `Status` value, the ADR exception, and the split between the two ESLint rules that gate specs and the `npm run check:spec-status` script that gates ADRs. The convention itself is published in AGENTS.md § Spec Header Table.

## The rule

A doc's status is read from the `| Status |` cell for a spec and the frontmatter `status:` key for an ADR, and buckets into one of five values. Every label in a bucket's row means that bucket, the two terminal buckets skip the check whatever the coverage, and a cell no parser reads buckets to nothing.

| Written into the doc                                             | Bucket                       |
| ---------------------------------------------------------------- | ---------------------------- |
| `Draft`                                                          | `draft`                      |
| `In Progress`, `In Review`, `Planning`, `WIP`, `Proposed`        | `in-progress`                |
| `Shipped`, `Implemented`, `Complete`, `Accepted`, `Done`, `Live` | `shipped`                    |
| `Retired`, `Superseded`, `Removed`, `Deprecated`, `Obsolete`     | `retired` - skips the check  |
| `Rejected`, `Abandoned`                                          | `rejected` - skips the check |

The bucket every non-terminal spec is entitled to claim is its own link coverage, counted over its testable statements alone.

| Testable statements linked | Tier      | Entitled to claim |
| -------------------------- | --------- | ----------------- |
| no testable statement      | `vacuous` | anything          |
| none                       | `none`    | `Draft`           |
| some                       | `partial` | `In Progress`     |
| all                        | `full`    | `Shipped`         |

- A spec claiming a tier above its coverage is reported against its status row, naming the status the coverage entitles it to ([validated by: a spec tagged Shipped with one unlinked statement is told to set "In Progress"](../../scripts/eslint-spec-docs.test.ts#L65)).
- A spec whose coverage matches its status passes ([validated by: a spec tagged "In Progress" with partial coverage passes both rules](../../scripts/eslint-spec-docs.test.ts#L75)).
- An alias buckets exactly as its canonical spelling does, in both directions: `In Review` behaves as `In Progress` and passes on partial coverage, while `Accepted` behaves as `Shipped` and is told to step down ([validated by: a spec tagged "In Review" with partial coverage buckets in-progress and passes](../../scripts/eslint-spec-docs.test.ts#L83), [accepted](../../scripts/eslint-spec-docs.test.ts#L87)).
- A terminal bucket skips the tier entirely: `Retired` and `Rejected` pass with no statement linked at all ([validated by: a spec tagged Retired or Rejected passes with no statement linked: terminal buckets skip the tier](../../scripts/eslint-spec-docs.test.ts#L96)).
- A spec carrying no status row is reported as untagged ([validated by: a spec with no status row fails with re-lint/require-status-matches-coverage as untagged](../../scripts/eslint-spec-docs.test.ts#L50)).
- A spec whose status no parser can read is reported as untagged against that row's own line ([validated by: a spec whose status row reads "Banana" fails as untagged at that row\'s line](../../scripts/eslint-spec-docs.test.ts#L59)).
- A spec that opens straight into a section, with no lead paragraph before the first `##`, is reported against line 1 ([validated by: a spec opening straight into a section fails with re-lint/require-intro-paragraph at line 1](../../scripts/eslint-spec-docs.test.ts#L38)).
- An ADR with no lead paragraph is reported by the same rule ([validated by: an ADR with no lead paragraph fails with re-lint/require-intro-paragraph](../../scripts/eslint-spec-docs.test.ts#L44)).

## The ADR exception

- An ADR with a lead paragraph and no test links passes both rules, because the coverage rule's `files` glob names specs alone ([validated by: an accepted ADR with a lead paragraph and no test links passes: ADRs are exempt from the coverage tier](../../scripts/eslint-spec-docs.test.ts#L79)).
- The script carries the half of the status rule that glob leaves unspoken for ADRs: an ADR whose frontmatter `status:` no parser can read is reported as untagged against that line ([validated by: an ADR whose frontmatter status reads "banana" reports untagged at that line](../../scripts/check-spec-status.test.ts#L43)).
- The script never applies the coverage tier to an ADR ([validated by: an accepted ADR with no test links reports nothing and exits 0: the coverage tier never applies to an ADR](../../scripts/check-spec-status.test.ts#L36)).
- A spec passed to the script's default run contributes nothing, whatever its status row ([validated by: a spec reports nothing here whatever its status row: specs are gated by eslint](../../scripts/check-spec-status.test.ts#L54)).
- An ADR's lead paragraph is likewise the rule's business, not the script's ([validated by: an ADR with no lead paragraph reports nothing here: lead paragraphs are gated by eslint](../../scripts/check-spec-status.test.ts#L61)).

## The script's contract

- With no path arguments it scans every `specs/<slug>/spec.md` in sorted slug order followed by every `adrs/*.md` in sorted name order, which is exactly the list an explicit invocation of those paths produces ([validated by: no doc paths scans the sorted specs directories followed by the sorted adrs](../../scripts/check-spec-status.test.ts#L167)).
- Each finding prints one line carrying the doc, the line a human has to edit, and the finding itself; the run closes with `spec-status: <N> findings across <M> docs (<D> scanned)` and exits 1 when `N` is above zero ([validated by: three ADRs report one finding across one doc and exit 1](../../scripts/check-spec-status.test.ts#L65)).
- `--coverage` replaces the report with one line per unlinked testable statement under a `spec-coverage: <U> unlinked testable statements across <M> docs (<D> scanned)` summary ([validated by: --coverage lists each unlinked statement and exits 0 under its own summary](../../scripts/check-spec-status.test.ts#L76)).
- `--coverage` exits 0 even on a doc the default run fails ([validated by: --coverage exits 0 on a doc the default run fails](../../scripts/check-spec-status.test.ts#L90)).
- `--json` replaces the report with an array alone, each entry carrying `doc`, `line`, `kind` and `message` ([validated by: --json prints only an array of findings carrying doc, line, kind and message](../../scripts/check-spec-status.test.ts#L97)).
- Under `--coverage` every entry's `kind` is `unlinked` ([validated by: --coverage --json labels every finding "unlinked"](../../scripts/check-spec-status.test.ts#L113)).
- An unrecognised flag exits 2 with the usage line rather than scanning anything ([validated by: an unknown flag exits 2 with the usage line](../../scripts/check-spec-status.test.ts#L124)).
- A doc path that cannot be read exits 2 naming that path, so a typo is never reported as a clean run ([validated by: a doc path that cannot be read exits 2 naming the path](../../scripts/check-spec-status.test.ts#L134)).
- A doc path under neither `specs/` nor `adrs/` exits 2 naming that path rather than being scanned with no corpus to judge it by ([validated by: a doc path under neither specs nor adrs exits 2 rather than scanning it](../../scripts/check-spec-status.test.ts#L143)).
- A relative path means the same doc from any working directory ([validated by: a relative doc path resolves against the repo root, not the working directory](../../scripts/check-spec-status.test.ts#L153)).
- An absolute path is accepted and reported root-relative ([validated by: an absolute doc path is scanned and reported repo-relative](../../scripts/check-spec-status.test.ts#L160)).

## Rationale

**Statement links are a report, not a gate.** 301 testable statements across this corpus carried no link when the checks landed, and the repo lints at zero warnings. A gate on day one would only mean a disabled gate, so the count lives behind `--coverage`, which always exits 0, and the backfill is ordinary work rather than a blocker.

**ADRs are exempt from the coverage tier, not from the other two checks.** The plugin's parser folds `accepted` into `shipped`, so an ADR carrying `status: accepted` and no test links would be told to link every statement it makes, which is the wrong ask of a decision record. The tier rule is scoped to specs by its `files` glob; ADRs keep their frontmatter status, are still required to open with a lead paragraph by the intro rule, and to parse a status by the script. This repo carries both `accepted` and `proposed` ADRs, and `proposed` parses as cleanly as `accepted`.

**Rules where a rule can be scoped, a script where it cannot.** The lead-paragraph and coverage-tier verdicts are ESLint rules from `@re-cinq/eslint-plugin-re-lint`, scoped by `files` globs. The one thing a glob cannot say - "check that an ADR's status parses, but never its tier" - is the script's remaining default job, read through the package's `parseDocStatus`.

**Fixtures, not the repo's own docs.** The behavioural pins run against invented specs and ADRs under `scripts/fixtures/spec-status/`, linted with `--no-ignore` so the fixture globs listed in `eslint.config.mjs` judge them by the committed rules and never a copy; a sweep that adds a status row to a real spec cannot turn a pin red.

**The plugin's verdict, not a local one.** The lead-paragraph, status-bucket and coverage-tier verdicts all come from the plugin's published modules rather than a reimplementation: a guess at agreement is the failure mode the gate exists to close.

**No autofix.** Flipping a status row is mechanical, but only once the links behind it exist, and choosing which test validates a statement is a judgement neither rule nor script has a basis to make. They report; a person writes the link and then the row follows.
