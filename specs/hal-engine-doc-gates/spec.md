# HAL Engine documentation gates

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

Four rules about the documents this repository publishes, each of which held only because somebody remembered it. A code block that matches its source, a path in prose that resolves, a spike that says it is a spike, and an example region inside the EU. Every one of them had already been broken at least once before it was a gate: hand transcription put a wrong frame order, a field name that never existed and three unread config keys into shipped documents, and a Vertex snippet handed a reader a US region to copy.

They are separate scripts rather than one because they fail for different reasons and a red run should name the rule it broke.

## Blocks are generated, not transcribed

`npm run docs:check` compares every fenced TypeScript block in a covered document against the source its marker names, and `docs:fix` rewrites it from there.

- A recognised block carrying no marker at all is reported ([validated by: reports a recognised block that carries no marker at all](../../scripts/check-doc-blocks.test.ts#L89)).
- An opt-out states a reason, and one that does not is reported ([validated by: reports an opt-out that states no reason](../../scripts/check-doc-blocks.test.ts#L95)).
- An opt-out that states one is accepted ([validated by: accepts an opt-out that states one](../../scripts/check-doc-blocks.test.ts#L101)).
- A fence that is never closed is reported rather than compared against the rest of the file ([validated by: reports a block whose fence is never closed rather than comparing to end of file](../../scripts/check-doc-blocks.test.ts#L107)).
- A marker naming a declaration its source does not export is reported ([validated by: reports a marker naming a declaration the source does not export](../../scripts/check-doc-blocks.test.ts#L113)).

The fence tag is the gate's own blind spot, because a block it does not recognise keeps its marker and quietly stops being compared. Matching one spelling was not enough: `ts` renders identically to `typescript`, is already used elsewhere in this repository, and an editor or an author sidestepping a `--fix` conflict can produce it without meaning anything by it.

- A drifted block fenced `typescript` is reported ([validated by: compares a block fenced as typescript](../../scripts/check-doc-blocks.test.ts#L57)).
- One fenced `ts` is reported ([validated by: compares a block fenced as ts, which renders identically](../../scripts/check-doc-blocks.test.ts#L61)).
- One fenced `tsx` is reported ([validated by: compares a block fenced as tsx](../../scripts/check-doc-blocks.test.ts#L65)).
- One whose fence tag is capitalised is reported ([validated by: compares a block whose fence tag is capitalised](../../scripts/check-doc-blocks.test.ts#L69)).
- One whose fence carries an info string is reported ([validated by: compares a block whose fence carries an info string](../../scripts/check-doc-blocks.test.ts#L73)).
- A block that matches its source is accepted rather than reported for being recognised ([validated by: accepts a matching block rather than reporting every fence it recognises](../../scripts/check-doc-blocks.test.ts#L77)).
- A closing fence carrying trailing whitespace still closes its block ([validated by: closes on a fence carrying trailing whitespace](../../scripts/check-doc-blocks.test.ts#L81)).
- `--fix` rewrites a drifted block from its source ([validated by: rewrites a drifted block from its source](../../scripts/check-doc-blocks.test.ts#L121)).
- `--fix` leaves the document's own fence tag alone, so the gate does not impose a house style ([validated by: leaves a fence tag it did not write alone, so --fix does not rewrite the document's style](../../scripts/check-doc-blocks.test.ts#L129)).
- `--fix` on a tree that already matches produces no diff ([validated by: produces no diff on a tree that already matches](../../scripts/check-doc-blocks.test.ts#L137)).

## Paths in prose resolve

`npm run docs:check-paths` resolves every backticked repository path written in a document - `src/`, `scripts/`, `example/`, `smoke/`, `docs/`, `specs/`, `adrs/`, `dist/`, `.github/` and `.specify/`. A path that legitimately does not resolve is named in the script's own allowlist with the reason, because an exception has to be written down to be one; narrowing the pattern instead would hide every other path behind the same prefix. A path in prose is a citation, and a citation nobody resolves rots in silence: the file moves, the sentence naming it stays, and the next reader follows it to nothing.

- A document whose cited paths all resolve passes, including one written with a line suffix - which line a citation lands on is `repoint-spec-anchors.mjs`'s question, not this one ([validated by: passes a document whose cited paths all resolve, including one carrying a line suffix](../../scripts/check-doc-gates.test.ts#L12)).
- A placeholder and a glob name no single file and are not checked ([validated by: ignores a placeholder and a glob, which name no single file](../../scripts/check-doc-gates.test.ts#L16)).
- A cited path that does not exist fails the run ([validated by: fails a document citing a path that does not exist](../../scripts/check-doc-gates.test.ts#L20)).
- The report names the document, the line and the missing path ([validated by: names the document, the line and the missing path](../../scripts/check-doc-gates.test.ts#L24)).

## A spike says that it is one

`npm run docs:check-spikes` requires every document under `docs/spikes/` to open with a status block. A spike records what somebody believed on the day they wrote it; served as documentation without that said out loud - and Lore does serve these - it reads as current design, which is how a superseded proposal becomes the thing a reader implements.

- A spike opening with a status block passes ([validated by: passes a spike opening with a status block](../../scripts/check-doc-gates.test.ts#L32)).
- A spike carrying none fails ([validated by: fails a spike carrying no status block](../../scripts/check-doc-gates.test.ts#L36)).
- A block buried below the head of the file fails, because a reader meets the body first ([validated by: fails a status block buried below the head of the file, where a reader will not meet it](../../scripts/check-doc-gates.test.ts#L40)).
- The report names the file it refused ([validated by: names the file it refused](../../scripts/check-doc-gates.test.ts#L44)).

## Example regions are EU regions

`npm run check:regions` refuses a cloud region outside the EU in anything a reader copies. `location` and `region` reach the vendor SDK unvalidated, so a US region in an example is a cross-border transfer somebody made by following the documentation.

The check reads fenced blocks and source files, not prose. Fences are read as CommonMark writes them: three backticks or three tildes, up to three spaces of indent, closing only on the same character - because the ordinary way a guide shows a step is an indented fence inside a numbered list, and reading only the unindented backtick spelling made exactly that invisible. A spec sentence recording that an example *used to* name a US region is a record of a correction, not a snippet, and rewriting it would erase the account of the defect.

- An EU region in an example passes ([validated by: passes an EU region in an example](../../scripts/check-doc-gates.test.ts#L50)).
- A non-EU region in an example fails ([validated by: fails a non-EU region in an example](../../scripts/check-doc-gates.test.ts#L54)).
- A non-EU region set through an environment variable fails ([validated by: fails a non-EU region set through an environment variable](../../scripts/check-doc-gates.test.ts#L58)).
- A region named in prose is not a snippet and is not checked ([validated by: ignores a region named in prose, which records a change rather than instructing](../../scripts/check-doc-gates.test.ts#L62)).
- Every line of a source example is checked, having no fence to sit inside ([validated by: checks every line of a source example, which has no fence to sit inside](../../scripts/check-doc-gates.test.ts#L66)).
- An indented fence inside a numbered list is read, and so is a tilde fence ([validated by: reads an indented fence and a tilde fence, which a guide writes as a step](../../scripts/check-doc-gates.test.ts#L74)).
- The report names the region it refused ([validated by: names the region it refused](../../scripts/check-doc-gates.test.ts#L70)).

The prefix rule is a vendor naming convention rather than a legal test. `eu-west-2` is London, which passes this check while sitting outside the EU; where data may actually come to rest is a transfer-basis question this gate does not answer and should not be read as answering.

## A citation names the test it cites

`npm run spec:names` holds every `([validated by: <name>](path#Lnn))` citation to the declaration it names, and `spec:names:fix` repoints the line from the name.

A line number is the wrong thing to cite. Inserting one import above a suite moves every test below it, and each citation silently lands on a different, still-valid declaration - so the spec still reads as cited while pointing at the wrong test. The baseline comparison in `repoint-spec-anchors.mjs` cannot see this on the branch that edits the spec, which is exactly the branch where it happens; this check needs no baseline because the name travels with the citation.

The `#Lnn` stays. The lint rule and the coverage job both index by line, and a citation carrying no line marks the whole file covered rather than one test - the weakest possible reading of a citation.

- A citation whose name matches the declaration it points at is accepted ([validated by: accepts a citation whose name matches the declaration it points at](../../scripts/check-spec-anchor-names.test.ts#L27)).
- A citation whose line has moved away from the test it names is reported ([validated by: reports a citation whose line has moved away from the test it names](../../scripts/check-spec-anchor-names.test.ts#L31)).
- The report names the line the test actually sits on ([validated by: names the line the cited test actually sits on, so the repair is obvious](../../scripts/check-spec-anchor-names.test.ts#L35)).
- A citation carrying no name at all is reported ([validated by: reports a citation carrying no test name at all](../../scripts/check-spec-anchor-names.test.ts#L39)).
- A name no declaration in the cited file has is reported ([validated by: reports a name no declaration in the cited file has](../../scripts/check-spec-anchor-names.test.ts#L43)).
- `--fix` repoints a drifted citation from the name it carries ([validated by: repoints a drifted citation from the name it carries](../../scripts/check-spec-anchor-names.test.ts#L47)).
- `--fix` fills in a missing name from the declaration its line points at ([validated by: fills in a missing name from the declaration the line points at](../../scripts/check-spec-anchor-names.test.ts#L53)).
- `--fix` leaves a citation that already agrees untouched ([validated by: leaves a citation that already agrees with its declaration untouched](../../scripts/check-spec-anchor-names.test.ts#L59)).

A name declared more than once in one file is reported and never guessed at, whether or not the line currently agrees. Resolving it by proximity was tried and removed: the nearest declaration is the one the author meant only while the shift is smaller than half the gap between the duplicates, and past that the tool rewrites the spec to cite the wrong test, after which every gate reports clean. That was not hypothetical - `src/transport/routes/chats.test.ts` declared one name twice, both were cited, and `--fix` collapsed them onto one line. The two tests were renamed apart; the mechanism that allowed it is gone.

- A name matching two declarations is reported rather than repointed ([validated by: reports a name that two declarations share, rather than choosing between them](../../scripts/check-spec-anchor-names.test.ts#L66)).
- `--fix` leaves an ambiguous citation exactly as it found it ([validated by: refuses to rewrite an ambiguous citation](../../scripts/check-spec-anchor-names.test.ts#L70)).
- A name carrying a bracket is refused rather than written into a label it would break ([validated by: refuses to write a name that would break the markdown label](../../scripts/check-spec-anchor-names.test.ts#L77)).
