# HAL Engine spec anchor drift

| Field  | Value |
| ------ | ----- |
| Issue  | n/a   |
| Status | In Progress |

A citation written `([validated by](../../src/X.test.ts#Lnn))` names a line, and a line number is the least stable thing a file has. Insert eight lines above it and the anchor still resolves, still renders, and now points at something else entirely — the spec reads as cited while citing the wrong thing, and nothing about it looks wrong. `scripts/repoint-spec-anchors.mjs` closes that: it resolves each anchor to the content it cited in a baseline ref, finds that content in the working copy, and rewrites the number. `--check` is the CI gate that refuses drift; a plain run is the fix.

## What counts as an anchor

Any relative path with a file extension followed by `#L<n>`, in any spec under `specs/<slug>/spec.md` plus `.specify/spec.md`. A link whose fragment is not a line number is not an anchor and is left alone, however much the file around it moves ([validated by: leaves a link whose fragment is not a line number untouched](../../scripts/repoint-spec-anchors.test.ts#L506)). Test files are the common case, but nothing restricts it to them: a citation into a workflow, a config or a script is repointed the same way ([validated by: repoints docs, README and script citations alike](../../scripts/repoint-spec-anchors.test.ts#L454), [root config](../../scripts/repoint-spec-anchors.test.ts#L476), [workflow and manifest](../../scripts/repoint-spec-anchors.test.ts#L490)).

The label is not part of the anchor. A descriptive label such as `[validated by]` is never touched ([validated by: leaves a descriptive label alone while syncing a short-form one beside it](../../scripts/repoint-spec-anchors.test.ts#L420)). A short-form `[Lnn](../../src/X.test.ts#Lnn)` is different: its label carries no meaning beyond the number, so it is force-synced to whatever its own href says ([validated by: syncs labels even in a spec skipped for a differing anchor set](../../scripts/repoint-spec-anchors.test.ts#L399)). Syncing happens after the rewrite, so a repointed href carries its label with it in the same run ([validated by: carries the label along when the href is repointed](../../scripts/repoint-spec-anchors.test.ts#L354)).

## The baseline is the point

Baseline line numbers come from the base ref's copy of the **spec**, never from the working copy.

- That is what makes a second run against the same baseline a no-op rather than a second translation ([validated by: is a no-op the second time, because the baseline is read from the base ref](../../scripts/repoint-spec-anchors.test.ts#L76)).
- `base-ref` defaults to `origin/main` ([validated by: defaults the base ref to origin/main](../../scripts/repoint-spec-anchors.test.ts#L612)).

Three cases have no baseline to reason from, and each is skipped rather than guessed:

- A spec absent from the base ref is skipped whole. It is new, so no earlier line numbers exist to translate ([validated by: skips a spec absent from the base ref](../../scripts/repoint-spec-anchors.test.ts#L234)).
- A spec whose ordered list of cited paths differs from the base ref's is skipped whole. Its anchors were authored against the working tree ([validated by: skips a spec whose ordered anchor paths differ from the base ref](../../scripts/repoint-spec-anchors.test.ts#L214)).
- A single anchor whose line differs from the base spec's at the same position was deliberately retargeted by a spec edit. It is taken as authored, never rewritten, and counted under `retargeted (not checked)` ([validated by: takes a manually retargeted anchor as authored and never rewrites it](../../scripts/repoint-spec-anchors.test.ts#L246)).

Skipping suspends only the baseline comparison. Rotten anchors are still reported in every one of those cases ([validated by: still checks a spec that was skipped for a differing anchor set](../../scripts/repoint-spec-anchors.test.ts#L326)).

## Resolving a moved anchor

The content of the baseline line is looked up in the working copy of the same file.

- Exactly one match is the answer ([validated by: moves each anchor to where the base ref's line content now lives](../../scripts/repoint-spec-anchors.test.ts#L64)).
- Lines are compared with quotes and whitespace dropped, so a formatter pass over a cited file is not drift: the anchor follows the line it cited, and a file reformatted in place reads as up to date ([validated by: follows a line a formatter rewrote, because quotes and spacing are not drift](../../scripts/repoint-spec-anchors.test.ts#L651), [validated by: reads a file reformatted in place as up to date under --check](../../scripts/repoint-spec-anchors.test.ts#L664)).
- No match is `unresolved`: the cited line is gone, and a person has to decide what the spec meant ([validated by: reports an anchor whose baseline content is gone as unresolved, and leaves it alone](../../scripts/repoint-spec-anchors.test.ts#L90)).
- Several matches are scored against the four lines either side, and the candidate whose neighbourhood best reproduces the baseline's wins ([validated by: picks the occurrence whose surrounding lines match the baseline](../../scripts/repoint-spec-anchors.test.ts#L144)).
- If two candidates score equally the anchor is `unresolved` as ambiguous. It is never a coin flip ([validated by: refuses to guess when the context ties, and rewrites nothing](../../scripts/repoint-spec-anchors.test.ts#L193)).
- Two anchors citing identical content each resolve to their own occurrence rather than collapsing onto one, because every anchor is resolved from its own baseline line ([validated by: sends two identical assertions to their own occurrences](../../scripts/repoint-spec-anchors.test.ts#L152)).

The consequence is a constraint on what to cite. A file built of repeated blocks — a workflow whose jobs share an identical setup, a table of near-identical rows — must be cited on a line unique to the step being cited, because the resolver will not choose between indistinguishable candidates ([validated by: tells apart duplicates that only differ four lines out](../../scripts/repoint-spec-anchors.test.ts#L175)).

## Rotten anchors

Independent of any baseline, an anchor must land somewhere real. Four ways it does not, all reported as `rotten` and all failing the run in both modes:

- the cited file does not exist in the working tree ([validated by: reports a citation into a file that is not in the working tree](../../scripts/repoint-spec-anchors.test.ts#L291)).
- the line is past the end of the file ([validated by: reports an anchor past the end of the cited file](../../scripts/repoint-spec-anchors.test.ts#L299)).
- the line is blank, or holds only closing punctuation — `)`, `]`, `}`, `>`, `,`, `;` ([validated by: fails in both modes when the anchor lands on a blank line](../../scripts/repoint-spec-anchors.test.ts#L263), [closing punctuation](../../scripts/repoint-spec-anchors.test.ts#L279)).
- the line is in a test file but is not the `it`/`test`/`describe` declaration ([validated by: reports an anchor that lands inside the test body as rotten](../../scripts/repoint-spec-anchors.test.ts#L551)).

A rotten href is reported rather than quietly synced: a short-form label whose href lands on a blank line leaves both modes failing with nothing rewritten, instead of the label being pulled into agreement with a broken target ([validated by: reports a label whose href is rotten rather than silently syncing it](../../scripts/repoint-spec-anchors.test.ts#L435)).

The last two are the ones that matter in practice. A citation that slides onto the closing bracket of the block it meant to name still resolves and still renders; it just proves nothing. A citation that slides onto an `expect` inside the body is worse, because it reads as a precise reference to a line no reader can turn back into the name of a case.

The declaration check is narrow on purpose:

- The declaration itself passes, and so does the enclosing `describe` — citing a group is a legitimate reference ([validated by: accepts an anchor on the it declaration itself](../../scripts/repoint-spec-anchors.test.ts#L533), [describe](../../scripts/repoint-spec-anchors.test.ts#L542)).
- Modified forms are declarations too: `it.each`, `test.skip` and the `f`/`x` prefixes all pass ([validated by: accepts the modified forms of a declaration](../../scripts/repoint-spec-anchors.test.ts#L573)).
- Only test files are held to it. A citation into a workflow, a config or `package.json` has no declaration to land on and is exempt ([validated by: holds only test files to the rule, so a non-declaration line elsewhere passes](../../scripts/repoint-spec-anchors.test.ts#L600)).
- It fails the plain run as well as `--check`, and rewrites nothing ([validated by: fails a body-line anchor in rewrite mode too, and rewrites nothing](../../scripts/repoint-spec-anchors.test.ts#L560)).
- It composes with repointing rather than replacing it: a test citation still moves from one declaration to another as lines shift above it ([validated by: repoints a test citation from one declaration to another as lines shift](../../scripts/repoint-spec-anchors.test.ts#L583)).

What it does not catch is a citation aimed at the wrong declaration. `#Lnn` on a real but unintended `it` passes every check here, because nothing mechanical relates a statement's prose to a test's name. That failure mode is a review concern, and the `require-spec-link` backlog is the instrument that surfaces it: the test the citation should have named goes on reading as uncited.

## The script's contract

`node scripts/repoint-spec-anchors.mjs [--check] [base-ref]`

- A plain run rewrites stale anchors in place and syncs short-form labels to their hrefs ([validated by: syncs a label to the line its own href names](../../scripts/repoint-spec-anchors.test.ts#L341)).
- `--check` rewrites nothing. It reports stale anchors instead, and reports a label disagreeing with its href as `mislabelled` ([validated by: --check names a label disagreeing with its href and rewrites nothing](../../scripts/repoint-spec-anchors.test.ts#L367)).
- Because `--check` judges labels against their current, un-repointed hrefs, a stale href is reported as stale in check mode and its label follows once a plain run repoints it. The two runs still converge in one pass ([validated by: converges: after one plain run, check passes and a second run is a no-op](../../scripts/repoint-spec-anchors.test.ts#L382)).
- Both modes print one summary line: the counts of moved-or-stale, up to date, unresolved, and relabelled-or-mislabelled anchors, plus a `retargeted (not checked)` line when that count is above zero.
- Details go to stderr, each prefixed with its kind: `stale`, `unresolved`, `rotten`, `mislabelled` ([validated by: exits 1 listing stale anchors and rewrites nothing](../../scripts/repoint-spec-anchors.test.ts#L111)).
- An anchor resting on the `describe` that groups a test is accepted: a statement can be validated by a whole group ([validated by: accepts an anchor on the describe line](../../scripts/repoint-spec-anchors.test.ts#L542)).
- A citation into a file outside `src/` — a root config, a workflow — is repointed like any other ([validated by: repoints a citation into a root config file](../../scripts/repoint-spec-anchors.test.ts#L476)).

Exit codes:

- `0` — nothing to fix ([validated by: exits 0 once a plain run has repointed them](../../scripts/repoint-spec-anchors.test.ts#L130)).
- `1` — any rotten or unresolved anchor, in either mode; and in `--check`, any stale or mislabelled one ([validated by: does not report one the rewrite itself repoints](../../scripts/repoint-spec-anchors.test.ts#L308)).
- `2` — an unrecognised flag. Nothing is scanned ([validated by: exits 2 with usage on an unknown flag](../../scripts/repoint-spec-anchors.test.ts#L640)).
- `2` — more than one base ref ([validated by: exits 2 with usage on more than one base ref](../../scripts/repoint-spec-anchors.test.ts#L644)).
- `2` — a base ref that does not resolve to a commit ([validated by: exits 2 naming a base ref that does not resolve](../../scripts/repoint-spec-anchors.test.ts#L631)).

## CI

`.github/workflows/ci.yml` runs `node scripts/repoint-spec-anchors.mjs --check origin/main` as the `Spec anchor check` step, and the workflow checks out with `fetch-depth: 0` because a shallow clone cannot serve `origin/main`. A red check is fixed by running the script without `--check` and committing what it rewrote.

The gate has a blind spot worth knowing. Specs that do not exist on `origin/main` yet — every spec on the branch that introduced them — are skipped for the baseline comparison, so on such a branch only the rotten check is really running. Staleness in a new spec is caught from the first merge onward, not before.

## Recorded decisions

- **A tie is a failure, not a guess.** The resolver could pick the first candidate, or the nearest to the old line. Both are plausible and both are silently wrong some of the time, which is the exact failure this script exists to prevent. Reporting ambiguity costs a person one decision and never moves a citation to the wrong place.
- **Rotten is checked without a baseline.** It would be simpler to check anchors only where a baseline exists, but that is precisely where new specs are, and a brand-new citation onto a closing brace is as broken as an old one.
- **Labels are force-synced, hrefs are not.** A retargeted href is a deliberate edit and is preserved. A short-form label that disagrees with it is not a deliberate edit — it is a leftover — so it is overwritten rather than reported.
- **A tie is reported, not broken, and the suite says so.** `scripts/repoint-spec-anchors.test.ts` drives the script against throwaway git repositories, because the whole subject is a base ref against a working tree. It is adapted from an existing suite for the same script, at one assertion per test.
