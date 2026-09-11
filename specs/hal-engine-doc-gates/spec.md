# HAL Engine documentation gates

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

Four rules about the documents this repository publishes, each of which held only because somebody remembered it. A code block that matches its source, a path in prose that resolves, a spike that says it is a spike, and an example region inside the EU. Every one of them had already been broken at least once before it was a gate: hand transcription put a wrong frame order, a field name that never existed and three unread config keys into shipped documents, and a Vertex snippet handed a reader a US region to copy.

They are separate scripts rather than one because they fail for different reasons and a red run should name the rule it broke.

## Blocks are generated, not transcribed

`npm run docs:check` compares every fenced TypeScript block in a covered document against the source its marker names, and `docs:fix` rewrites it from there.

- A recognised block carrying no marker at all is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L89)).
- An opt-out states a reason, and one that does not is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L95)).
- An opt-out that states one is accepted ([validated by](../../scripts/check-doc-blocks.test.ts#L101)).
- A fence that is never closed is reported rather than compared against the rest of the file ([validated by](../../scripts/check-doc-blocks.test.ts#L107)).
- A marker naming a declaration its source does not export is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L113)).

The fence tag is the gate's own blind spot, because a block it does not recognise keeps its marker and quietly stops being compared. Matching one spelling was not enough: `ts` renders identically to `typescript`, is already used elsewhere in this repository, and an editor or an author sidestepping a `--fix` conflict can produce it without meaning anything by it.

- A drifted block fenced `typescript` is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L57)).
- One fenced `ts` is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L61)).
- One fenced `tsx` is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L65)).
- One whose fence tag is capitalised is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L69)).
- One whose fence carries an info string is reported ([validated by](../../scripts/check-doc-blocks.test.ts#L73)).
- A block that matches its source is accepted rather than reported for being recognised ([validated by](../../scripts/check-doc-blocks.test.ts#L77)).
- A closing fence carrying trailing whitespace still closes its block ([validated by](../../scripts/check-doc-blocks.test.ts#L81)).
- `--fix` rewrites a drifted block from its source ([validated by](../../scripts/check-doc-blocks.test.ts#L121)).
- `--fix` leaves the document's own fence tag alone, so the gate does not impose a house style ([validated by](../../scripts/check-doc-blocks.test.ts#L129)).
- `--fix` on a tree that already matches produces no diff ([validated by](../../scripts/check-doc-blocks.test.ts#L137)).

## Paths in prose resolve

`npm run docs:check-paths` resolves every backticked repository path written in a document. A path in prose is a citation, and a citation nobody resolves rots in silence: the file moves, the sentence naming it stays, and the next reader follows it to nothing.

- A document whose cited paths all resolve passes, including one written with a line suffix - which line a citation lands on is `repoint-spec-anchors.mjs`'s question, not this one ([validated by](../../scripts/check-doc-gates.test.ts#L12)).
- A placeholder and a glob name no single file and are not checked ([validated by](../../scripts/check-doc-gates.test.ts#L16)).
- A cited path that does not exist fails the run ([validated by](../../scripts/check-doc-gates.test.ts#L20)).
- The report names the document, the line and the missing path ([validated by](../../scripts/check-doc-gates.test.ts#L24)).

## A spike says that it is one

`npm run docs:check-spikes` requires every document under `docs/spikes/` to open with a status block. A spike records what somebody believed on the day they wrote it; served as documentation without that said out loud - and Lore does serve these - it reads as current design, which is how a superseded proposal becomes the thing a reader implements.

- A spike opening with a status block passes ([validated by](../../scripts/check-doc-gates.test.ts#L32)).
- A spike carrying none fails ([validated by](../../scripts/check-doc-gates.test.ts#L36)).
- A block buried below the head of the file fails, because a reader meets the body first ([validated by](../../scripts/check-doc-gates.test.ts#L40)).
- The report names the file it refused ([validated by](../../scripts/check-doc-gates.test.ts#L44)).

## Example regions are EU regions

`npm run check:regions` refuses a cloud region outside the EU in anything a reader copies. `location` and `region` reach the vendor SDK unvalidated, so a US region in an example is a cross-border transfer somebody made by following the documentation.

The check reads fenced blocks and source files, not prose. A spec sentence recording that an example *used to* name a US region is a record of a correction, not a snippet, and rewriting it would erase the account of the defect.

- An EU region in an example passes ([validated by](../../scripts/check-doc-gates.test.ts#L50)).
- A non-EU region in an example fails ([validated by](../../scripts/check-doc-gates.test.ts#L54)).
- A non-EU region set through an environment variable fails ([validated by](../../scripts/check-doc-gates.test.ts#L58)).
- A region named in prose is not a snippet and is not checked ([validated by](../../scripts/check-doc-gates.test.ts#L62)).
- Every line of a source example is checked, having no fence to sit inside ([validated by](../../scripts/check-doc-gates.test.ts#L66)).
- The report names the region it refused ([validated by](../../scripts/check-doc-gates.test.ts#L70)).

The prefix rule is a vendor naming convention rather than a legal test. `eu-west-2` is London, which passes this check while sitting outside the EU; where data may actually come to rest is a transfer-basis question this gate does not answer and should not be read as answering.
