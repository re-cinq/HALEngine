---
adr_number: 1
title: Bedrock Converse API over InvokeModel
status: accepted
date: 2026-04-02
domains:
  - ai-providers
  - bedrock
  - streaming
---

# ADR-001: Bedrock Converse API over InvokeModel

This ADR records the choice of the AWS Bedrock Converse API, and specifically `ConverseStreamCommand`, as the way HAL Engine talks to Bedrock, in place of `InvokeModel` with per-model request payloads. Converse presents one message interface across every Bedrock model that supports messages, with tool calling and streaming built in, so swapping models is a configuration change rather than a code change. The cost accepted is a dependency on an API surface AWS controls, and the loss of model-specific parameters that only the raw payload exposes. This decision is implemented.

## Context

HAL Engine abstracts AI providers behind the `AIProvider` interface so that a consumer can switch between Bedrock, Vertex and others without touching orchestration. Bedrock offers two ways in: `InvokeModel`, which takes a payload shaped per model family, and the Converse API, which normalises those differences behind one request and response shape. The provider layer also has to stream deltas to the WebSocket transport and map tool calls both directions, so whichever API was chosen had to support both natively or force HAL Engine to implement them.

## Decision

Use the Converse API. `src/providers/bedrock/bedrockProvider.ts` constructs a `ConverseStreamCommand` and iterates the resulting event stream; `src/providers/bedrock/bedrockStreamHandlers.ts` maps those events onto `MessageChunk` values. `InvokeModel` appears nowhere in `src/`.

Required IAM permissions are `bedrock:InvokeModel` for the synchronous `Converse` call and `bedrock:InvokeModelWithResponseStream` for `ConverseStream`.

## Rationale

- One interface across all message-capable Bedrock models, so a model swap does not mean a rewrite of the provider.
- Tool calling is part of the API rather than something the provider has to encode into a model-specific payload and parse back out.
- Streaming has a first-class command, `ConverseStream`, which the entry-delta protocol in the transport layer depends on.
- It is the direction AWS points new integrations at; `InvokeModel` is the legacy path.

## Consequences

- The provider is written once and inherits new Bedrock models without change.
- Model-specific parameters reachable only through a raw `InvokeModel` payload are not available; a future need for one requires either a Converse passthrough field or a second code path.
- The event-stream shape is AWS's to change, and `parseStreamEvents` is coupled to it.
- `@aws-sdk/client-bedrock-runtime` is lazily required inside the provider so that consumers who never select Bedrock do not need the SDK installed.

## Alternatives considered

**`InvokeModel` with per-model payloads.** Rejected: it puts a model's request format into HAL Engine's provider layer, so every new model is new code, and both tool calling and streaming would have to be hand-implemented per family.

## References

- `docs/spikes/spike-bedrock-integration.md` — the full spike, including the comparison table, token limits per model, cost analysis and risk assessment. This ADR summarises its decision; the spike remains the record.
- `src/providers/bedrock/bedrockProvider.ts`, `src/providers/bedrock/bedrockStreamHandlers.ts`
