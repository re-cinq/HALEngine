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

## Anthropic ([anthropicProvider.ts](../src/providers/anthropic/anthropicProvider.ts))

1. Install `@anthropic-ai/sdk`
2. Use `new Anthropic({ apiKey })` to create a client
3. Call `client.messages.stream({ model, messages, max_tokens, system })`
4. Map streamed events to `MessageChunk` (text, tool_use, stop)

## OpenAI ([openaiProvider.ts](../src/providers/openai/openaiProvider.ts))

1. Install `openai`
2. Use `new OpenAI({ apiKey })` to create a client
3. Call `client.chat.completions.create({ model, messages, stream: true })`
4. Map streamed `ChatCompletionChunk` to `MessageChunk` (text, tool_use, stop)

## Both

`generateStructured` is required, not optional — returning `null` or `undefined`
silently breaks orchestration. Until it is implemented it must keep throwing
`AIError` with a descriptive message.
