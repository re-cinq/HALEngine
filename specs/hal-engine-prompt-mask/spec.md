# The Prompt Mask

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#66 |
| Status | Implemented          |

A deployer can pseudonymise what the model vendor sees: `privacy.mask` sends tokens in place of the values its detector recognises, and puts the real values back before anything downstream reads them.

## Background

Dropping a field the answer does not need is the cheaper control, and a tool can already project one away. A field the answer has to quote back, a person's name, cannot be dropped without deleting the answer, and sending a placeholder needs the real value put back before the user reads it. Nothing in the engine could do that in the return direction, because no seam sees both the outbound request and the inbound stream except the provider boundary. The requirement was confirmed before building: re-cinq/Otto's support agent sends booking fields to Gemini and wants OLT identifiers masked.

## The contract

- `withMask(provider, mask)` returns an `AIProvider` that sends the provider a token in place of every value the mask recognises, in all three carriers: a text message, a value anywhere in a tool call's `input`, and a tool result's content ([validated by: sends the provider no Ada Example in a text message, a tool-call input value or a tool-result string](../../src/providers/withMask.test.ts#L22)).
- The system prompt and the tool definitions pass through byte-identical: they are static instructions, and masking them would only corrupt them ([validated by: passes the system prompt and the tool definitions through byte-identical, since masking them would corrupt instructions](../../src/providers/withMask.test.ts#L34)).
- Text coming back is restored through a window that holds back `maxTokenLength - 1` characters, so a token split across chunks is restored whole and no chunk carries part of one; this delays the first visible text by up to that many characters ([validated by: restores a token split across two chunks to Ada Example approved it, with no chunk carrying part of it](../../src/providers/withMask.test.ts#L45)).
- What the window still holds is released as a `text` chunk before the next non-text chunk, `stop` included, so the order the provider chose survives ([validated by: releases the text it held back as a text chunk before the stop chunk, in that order](../../src/providers/withMask.test.ts#L57)).
- A model tool call's `input` is restored before the orchestrator runs it, so a tool reaches its downstream API with the real reference while the model only ever saw the token ([validated by: restores a masked reference in a model tool call before the tool's executor receives it](../../src/promptMask.test.ts#L22)).
- `afterModelResponse` receives the restored text, so an audit hook records what the user read ([validated by: hands afterModelResponse the real value, so an audit hook records what the user read](../../src/promptMask.test.ts#L50)).
- `generateStructured` is delegated with its parameters untouched, unmasked ([validated by: delegates generateStructured with its parameters untouched](../../src/providers/withMask.test.ts#L65)).
- An `apply` that throws fails the call with nothing sent to the vendor ([validated by: fails the call with nothing sent when apply throws](../../src/providers/withMask.test.ts#L76)).
- `createHalEngine` composes the mask outermost, over the fallback chain and each provider's retry, so one `bind()` covers a turn's attempts: a retry replays masked parameters, and every vendor tried receives text from the same binding ([validated by: binds the mask once for a turn the retry tier attempts twice, so both attempts send text from one binding](../../src/promptMask.test.ts#L69)).
- After a WebSocket turn through `createHalEngine`, neither the stored session nor any frame on the wire carries a token: both hold the real values ([validated by: stores no token after a WebSocket turn through createHalEngine: the session and the wire carry Ada Example](../../src/promptMask.test.ts#L93)).

## Limitations

The mask recognises only what its consumer's `PromptMask` describes: the engine ships the mechanism, no detector and no field-name list. Free text a user types reaches the model as typed unless the detector recognises it, which is a residual exposure. A token the model does not echo verbatim reaches the user as a token, a quality defect rather than a leak. Each `sendMessage` call binds anew, so a turn's tool rounds each get fresh tokens, and neither the vendor nor the deployer can correlate tokens across turns. With `privacy` absent, nothing wraps the provider.
