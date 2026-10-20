# Implementing a stub provider

Two providers ship as stubs: OpenAI and Anthropic. Both satisfy the `AIProvider`
interface and both throw `AIError` from every method, so selecting one fails
loudly at the first call rather than returning empty responses. This page holds
the per-SDK detail for finishing them; [CLAUDE.md](../CLAUDE.md) § Adding a provider has the
repo-level checklist, and [specs/hal-engine-providers/spec.md](../specs/hal-engine-providers/spec.md) is
the normative description of the provider contract.

[bedrockProvider.ts](../src/providers/bedrock/bedrockProvider.ts) is the full
reference implementation for streaming, and
[vertexProvider.ts](../src/providers/vertex/vertexProvider.ts) for
`generateStructured`.

Bedrock reports token counts on its stop chunk, read from the Converse stream's
`metadata` event; AWS sends that event after `messageStop`, so the stop chunk
waits for the stream to end. A provider you finish reports its counts on its
stop chunk the same way, as `usage`.

## Anthropic ([anthropicProvider.ts](../src/providers/anthropic/anthropicProvider.ts))

1. Install `@anthropic-ai/sdk`
2. Use `new Anthropic({ apiKey })` to create a client
3. Call `client.messages.stream({ model, messages, max_tokens, system }, { signal: params.signal })`
4. Map streamed events to `MessageChunk` (text, tool_use, stop)

## OpenAI ([openaiProvider.ts](../src/providers/openai/openaiProvider.ts))

1. Install `openai`
2. Use `new OpenAI({ apiKey })` to create a client
3. Call `client.chat.completions.create({ model, messages, stream: true }, { signal: params.signal })`
4. Map streamed `ChatCompletionChunk` to `MessageChunk` (text, tool_use, stop)

## Both

A turn that asks for a tool must end with `stopReason: 'tool_use'`: it is the only
value the tool loop reads, so any other value ends the turn without running the
tool. A vendor that marks tool calls structurally rather than through its finish
reason, as Vertex does, needs the value derived from the `tool_use` chunks the
provider yielded.

A vendor that attaches a token to a tool call and needs it back in the turn's next
request, as Gemini 3 does with `thoughtSignature`, puts it on `toolCall.signature`.
The orchestrator returns it on that call's `tool_use` block, and the provider sends
it back exactly as it came: nothing for a call that came without one.

`generateStructured` is required, not optional — returning `null` or `undefined`
silently breaks orchestration. Until it is implemented it must keep throwing
`AIError` with a descriptive message.

Both SDKs take the signal as a request option, so an abort cancels the request at
the vendor, and both reject the pending call when it does. Honour it the way
§ Cancellation below describes.

## Cancellation

`SendMessageParams.signal` asks a provider to stop. Once it aborts, the provider
yields nothing more and ends its stream without an error: an abort is the engine's
own decision, such as `withRetry` abandoning an attempt, not a vendor failure. A
signal already aborted when `sendMessage` is called must send nothing at all. The
normative statements are in
[specs/hal-engine-providers/spec.md](../specs/hal-engine-providers/spec.md) § Cancellation.

What an abort stops depends on the vendor SDK, measured at these versions:

| Provider | SDK measured | What an abort stops |
| --- | --- | --- |
| Bedrock | `@aws-sdk/client-bedrock-runtime@3.1020.0` (`@smithy/node-http-handler@4.5.1`) | The request at the vendor: the SDK's HTTP/2 handler closes the stream, so the vendor stops sending. |
| Vertex | `@google/genai@2.26.0` | The request's connection: the SDK passes the signal to `fetch`, so no more of the answer arrives. Google documents that the service may still finish generating, and bill, the request. Under `@google-cloud/vertexai@1.10.4` only the engine's reading stopped, and the vendor's response ran to its end. |
| Mock | built in | Everything, at once: there is no vendor. |

**GDPR.** Bedrock and Vertex both close the request when a turn is abandoned, so
no more of the answer crosses the transfer boundary back to the engine. What the
vendor already received stays with it, and Vertex may still finish generating the
answer it was asked for; a deployer recording where personal data goes records
both. Re-measure the Vertex row when upgrading `@google/genai`.

A provider honours the signal in three places, as the custom-provider template in
[specs/hal-engine-providers/spec.md](../specs/hal-engine-providers/spec.md)
§ Implementing a Custom Provider shows:

1. Before sending: a signal already aborted sends nothing.
2. In the call: hand the signal to the SDK, so it can cancel the request at the vendor.
3. While reading, and in the `catch`: read nothing more once the signal aborts, and
   treat the SDK's abort rejection as the end of the stream, not as an `AIError`.
