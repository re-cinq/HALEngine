# AI Providers

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

hal-engine ships with built-in support for multiple AI providers. All providers implement the same `AIProvider` interface, so switching between them requires only a configuration change.

## Supported Providers

Model ids below were checked against vendor sources on 2026-09-11, by documentation and by a live publisher-model listing for Vertex. Ids are vendor-controlled and retire on the vendor's schedule, not this package's: `modelId` is a bare unvalidated string on both working providers, so a retired id reaches a consumer as an error that looks like their credentials are wrong. Re-check before trusting a snippet that is older than a few months.

Implementation status is scored per method in `README.md`, which carries the only such matrix.

| Provider           | Type string   | Package                           |
| ------------------ | ------------- | --------------------------------- |
| AWS Bedrock        | `'bedrock'`   | `@aws-sdk/client-bedrock-runtime` |
| Google Vertex AI   | `'vertex'`    | `@google/genai`                   |
| OpenAI             | `'openai'`    | `openai`                          |
| Anthropic (Direct) | `'anthropic'` | `@anthropic-ai/sdk`               |
| Mock               | `'mock'`      | (built-in)                        |

## Configuring a Provider

Pass the provider config to `createHalEngine()` or use `createProvider()` directly:

<!-- doc-block: none -- a composed provider configuration; its fields are checked through src/config.ts by typecheck -->
```typescript
import {createHalEngine} from '@re-cinq/hal-engine';

// Via createHalEngine
const engine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: 4096,
  },
  // ... rest of config
});

// Or standalone
import {createProvider} from '@re-cinq/hal-engine';

const provider = createProvider({
  type: 'openai',
  apiKey: requireEnv('OPENAI_API_KEY'),
  model: 'gpt-4o',
});
```

`apiKey` is a `string`, and `process.env.X` is `string | undefined`, so reading one straight into the config does not compile under `strict: true`. `requireEnv` stands in for whatever your project does about that, and the shape matters more than the name: fail at startup on a missing credential rather than at the first model call, where it arrives as an authentication error from the vendor.

<!-- doc-block: none -- the guard a reader writes in their own project, not something this package exports -->
```typescript
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);

  return value;
}
```

## AWS Bedrock

Uses the Converse API for a unified interface across all Bedrock-hosted models.

<!-- doc-block: none -- a composed provider configuration; its fields are checked through src/config.ts by typecheck -->
```typescript
const engine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: 4096,
  },
  // ...
});
```

The `eu.` prefix is not decoration. Claude Sonnet 4.5 supports no in-region inference in any region, so the bare `anthropic.claude-sonnet-4-5-20250929-v1:0` fails and a geo inference profile is required: `eu.` from an EU region, `us.` from a US one. The profile keeps requests inside that geography, which is why the EU form pairs with `region: 'eu-west-1'` here. `modelId` is an unvalidated string, so getting this wrong surfaces as a vendor error on the first message, not at startup.

**Credentials:**

```bash
AWS_ACCESS_KEY_ID=<from-environment>
AWS_SECRET_ACCESS_KEY=<from-environment>
```

This package reads neither. `src/providers/bedrock/bedrockProvider.ts:28` constructs `new BedrockRuntimeClient({region: config.region})` and the AWS SDK resolves credentials itself, from the environment, a shared profile, or an instance role. `region` is the config field above, not `AWS_REGION`: setting the variable and passing a different `region` gives you the config value with no warning.

**IAM permissions required:**

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`

A `tool_use` block's `signature`, which only Vertex reads, is left out of the Converse request ([validated by: sends a tool_use block carrying signature sig-1 to Bedrock as a toolUse without it](../../src/providers/bedrock/bedrockProvider.test.ts#L65)).

See [spike-bedrock-integration.md](../../docs/spikes/spike-bedrock-integration.md) for detailed cost analysis, token limits, and error handling patterns.

## Google Vertex AI

Supports streaming through `sendMessage` and structured JSON output through `generateStructured` ([validated by: streams text chunks from Vertex AI response](../../src/providers/vertex/vertexProvider.test.ts#L69), [validated by: returns parsed JSON from Vertex response](../../src/providers/vertex/vertexProvider.test.ts#L406)).

<!-- doc-block: none -- a composed provider configuration; its fields are checked through src/config.ts by typecheck -->
```typescript
const engine = createHalEngine({
  provider: {
    type: 'vertex',
    projectId: 'my-gcp-project',
    location: 'europe-west4',
    modelId: 'gemini-2.5-pro',
    maxTokens: 4096,
    googleAuthOptions: {
      keyFilename: '/path/to/service-account.json',
    },
    // Optional host override. location: 'eu' reaches the EU multi-region on its own;
    // set this to route any EU location value, such as europe-west4 above, to that host:
    // apiEndpoint: 'aiplatform.eu.rep.googleapis.com',
  },
  // ...
});
```

Measured on 2026-09-25 against project `re5-n8n-platform`, one `generateContent` call per cell: `gemini-3.1-flash-lite` answers on `aiplatform.eu.rep.googleapis.com` with `location` set to either `eu` or `europe-west4`, and returns 404 on the `europe-west4` regional host. The host routes; the `location` segment does not override it. So a reader who uncomments `apiEndpoint` without touching `location` gets the EU multi-region, which is the point of the field.

`location` selects the regional endpoint, so it decides where the request is processed and which jurisdiction the data stays in - not merely which datacentre is nearest. It is passed straight to `new GoogleGenAI({vertexai: true, location})` and the engine does not validate it: a region that does not serve the model surfaces as a vendor error on the first call, not at construction. The examples here use `europe-west4`.

The `eu` multi-region is a distinct host, `aiplatform.eu.rep.googleapis.com`. `@google/genai` derives it from `location: 'eu'` itself, as it does `us`, and gives any other location its regional host, so `location` alone now reaches it; under `@google-cloud/vertexai` it could not. The optional `apiEndpoint` on `VertexConfig` still overrides the host: it becomes the client's base URL, `https://<apiEndpoint>/`, and when it is absent no base URL is passed, so a deployment that sets only `location` gets the SDK's own choice of host ([validated by: forwards apiEndpoint to the client as its base URL for the eu multi-region](../../src/providers/vertex/vertexProvider.test.ts#L517), [validated by: omits apiEndpoint when unset so single-region deployments are unchanged](../../src/providers/vertex/vertexProvider.test.ts#L532)).

Measured on 2026-10-19 with `@google/genai` 2.26.0 against project `re5-n8n-platform`: a tool-using turn on `gemini-3.1-flash-lite` with `location: 'eu'` reached `aiplatform.eu.rep.googleapis.com` both with `apiEndpoint` unset and set to that host, ran its tool, and sent the call's thought signature back accepted.

- The client is always created in Vertex mode, never against the Gemini API, on Vertex's GA `v1` API, which `@google-cloud/vertexai` called and `@google/genai` would otherwise replace with `v1beta1`, carrying the configured project, location and auth options ([validated by: creates the client in Vertex mode on the v1 API with the configured project, location and auth options](../../src/providers/vertex/vertexProvider.test.ts#L505)).

**Credentials:**

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

This package reads neither. `createVertexProvider` constructs `new GoogleGenAI({vertexai: true, project, location, googleAuthOptions})` and Google's auth library resolves credentials itself, from `googleAuthOptions`, that variable, or the metadata server. `projectId` is the config field above, not `GOOGLE_CLOUD_PROJECT`: setting the variable and passing a different `projectId` gives you the config value with no warning.

**Structured output example:**
<!-- doc-block: none -- a structured-output call against a live model, which CI cannot make -->
```typescript
import {createVertexProvider} from '@re-cinq/hal-engine';

const provider = createVertexProvider({
  type: 'vertex',
  projectId: 'my-project',
  location: 'europe-west4',
  modelId: 'gemini-2.5-flash',
});

const result = await provider.generateStructured<{score: number; feedback: string}>({
  messages: [{role: 'user', content: 'Evaluate this answer'}],
  systemPrompt: 'You are an evaluator.',
  responseSchema: {
    type: 'object',
    properties: {
      score: {type: 'number', description: 'Score from 0 to 100'},
      feedback: {type: 'string', description: 'Explanation'},
    },
    required: ['score', 'feedback'],
  },
});
```

### Streaming

- A function call part becomes a `tool_use` chunk. Vertex reports no call id of its own, so the function's name is used as the id as well ([validated by: yields a tool_use chunk for a function call and ends the turn tool_use, with its usage](../../src/providers/vertex/vertexProvider.test.ts#L90)).
- A function call that carries no arguments becomes a `tool_use` chunk with an empty `input` ([validated by: turns a function call that carries no arguments into a tool_use chunk with an empty input](../../src/providers/vertex/vertexProvider.test.ts#L138)).
- A turn that called a tool ends with `stopReason: 'tool_use'`, the one value the tool loop reads, so Bedrock, Vertex and the mock now agree on it. Vertex has no finish reason for a tool call: it marks the call structurally, with `functionCall` parts, and finishes the turn `STOP` like any other, so the provider derives `tool_use` from the `tool_use` chunks it yielded ([validated by: yields a tool_use chunk for a function call and ends the turn tool_use, with its usage](../../src/providers/vertex/vertexProvider.test.ts#L90)).
- Such a turn used to end `end_turn`, which contradicted the `tool_use` chunk before it, and the tool loop, the field's only reader, stopped there: on Vertex no tool ran, and the turn ended with no answer. Driven through the orchestrator, a function call now runs its registered tool and the next request carries its result as a `functionResponse` named after the function ([validated by: closes the tool loop on its own chunks: the call runs its tool and the next request carries the result](../../src/vertexToolLoop.test.ts#L81)).
- A text-only turn that finishes `STOP` still ends `end_turn` ([validated by: streams text chunks from Vertex AI response](../../src/providers/vertex/vertexProvider.test.ts#L69)).
- A `MAX_TOKENS` finish reason becomes the stop reason `max_tokens`, so a truncated reply is distinguishable from a completed one ([validated by: maps MAX_TOKENS finish reason](../../src/providers/vertex/vertexProvider.test.ts#L116)).
- Any other finish reason is passed on lower-cased, so `SAFETY` ends the turn `safety` ([validated by: passes any other finish reason on lower-cased, SAFETY as safety](../../src/providers/vertex/vertexProvider.test.ts#L128)).
- A truncated turn ends `max_tokens` even when it carried a function call, since its arguments may be cut short and the loop must not run it ([validated by: ends a truncated function-call turn max_tokens, so the loop never runs its call](../../src/providers/vertex/vertexProvider.test.ts#L346)).
- Every stream ends with exactly one `stop` chunk: one whose chunks name no finish reason still gets one, `tool_use` after a function call and `end_turn` after text alone, with the last usage it saw ([validated by: ends a stream that names no finish reason with one stop chunk: tool_use after a call, end_turn after text](../../src/providers/vertex/vertexProvider.test.ts#L356)).
- The turn ends at the first finish reason, so a second one adds no `stop` chunk ([validated by: ends the turn at the first finish reason, so a second one adds no stop chunk](../../src/providers/vertex/vertexProvider.test.ts#L373)).
- A stream whose signal aborted as it ended gets no `stop` chunk, since an aborted provider yields nothing more ([validated by: adds no stop chunk to a stream whose signal aborted as it ended](../../src/providers/vertex/vertexProvider.test.ts#L389)).
- A candidate carrying no parts is skipped rather than emitted as an empty chunk ([validated by: skips chunks with no candidate parts](../../src/providers/vertex/vertexProvider.test.ts#L207)).
- The `assistant` role is sent to Vertex as `model`, which is the only role name its API accepts for a prior reply; `user` passes through unchanged ([validated by: maps assistant role to model for Vertex API](../../src/providers/vertex/vertexProvider.test.ts#L221)).
- One request carries the model, the system prompt as `systemInstruction`, the tools as function declarations and `maxOutputTokens`, the call's own value over the configured one; the SDK turns each tool's JSON Schema into Gemini's schema form, upper-casing its types and dropping `additionalProperties` ([validated by: sends the model, the system prompt, the tools and the configured max tokens in one request](../../src/providers/vertex/vertexProvider.test.ts#L310)).

### Thought signatures

Gemini 3 models attach an opaque `thoughtSignature` to the part that carries a function call, and validate every step of the current turn, which begins at the latest user message that is not a function response: a call of that turn sent back without its signature is refused with a `400` ([Google: Thought signatures](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures)). The provider builds `contents` itself, so it carries the signature through the turn:

- A function-call part's `thoughtSignature` rides on its `tool_use` chunk as `toolCall.signature` ([validated by: carries a function-call part's thoughtSignature sig-1 onto its tool_use chunk](../../src/providers/vertex/vertexProvider.test.ts#L103)).
- The turn's next request sends each function call back with exactly the signature it came with, one per call when an answer holds several ([validated by: sends round one's thoughtSignature sig-1 back on its functionCall part in the turn's next request](../../src/vertexToolLoop.test.ts#L57), [validated by: sends two calls of one answer back with exactly the signatures they came with, sig-a and sig-b](../../src/vertexToolLoop.test.ts#L63)).
- Nothing is invented: a call that came unsigned goes back with no `thoughtSignature` key ([validated by: sends a call that came unsigned back with no thoughtSignature key, beside a signed one](../../src/vertexToolLoop.test.ts#L75)).
- Calls from earlier turns are rebuilt from session history without one, which the API allows because they precede the current turn. The signature is never stored in a session entry and never reaches the WebSocket protocol.

### Structured output

- `generateStructured` sets `responseMimeType` to `application/json` and passes the schema with its type names upper-cased, which is the form the Vertex SDK expects ([validated by: configures the request with responseMimeType and responseSchema](../../src/providers/vertex/vertexProvider.test.ts#L420)).
- A response body that is not valid JSON raises `AIError` with code `PARSE_ERROR`, rather than returning something the caller would have to re-check ([validated by: throws AIError with PARSE_ERROR on invalid JSON](../../src/providers/vertex/vertexProvider.test.ts#L451)).
- A response with no candidates raises `PARSE_ERROR` as well, since it carries no JSON ([validated by: raises PARSE_ERROR for a structured response with no candidates, which carries no JSON](../../src/providers/vertex/vertexProvider.test.ts#L461)).
- An `enum` passes through the response schema unchanged, and an array's `items` schema is mapped like any other, its type upper-cased ([validated by: passes an enum and an array of items through the response schema, upper-casing the item type](../../src/providers/vertex/vertexProvider.test.ts#L467)).

### Error mapping

- A failure whose HTTP status is `429`, or whose message names `429` or `RESOURCE_EXHAUSTED`, becomes `RATE_LIMITED` and is marked retryable ([validated by: throws AIError with RATE_LIMITED on 429](../../src/providers/vertex/vertexProvider.test.ts#L160), [validated by: maps a failure by its HTTP status when its message names no code: 429 to RATE_LIMITED, 403 to AUTH_ERROR](../../src/providers/vertex/vertexProvider.test.ts#L330)).
- A failure whose HTTP status is `401` or `403`, or whose message names `401`, `403` or `PERMISSION_DENIED`, becomes `AUTH_ERROR`; `@google/genai`'s `ApiError` carries the status, and its message is the vendor's JSON error body ([validated by: throws AIError with AUTH_ERROR on permission denied](../../src/providers/vertex/vertexProvider.test.ts#L172), [validated by: maps a failure by its HTTP status when its message names no code: 429 to RATE_LIMITED, 403 to AUTH_ERROR](../../src/providers/vertex/vertexProvider.test.ts#L330), [validated by: still maps a failure carrying no status by its message, 403 Forbidden to AUTH_ERROR](../../src/providers/vertex/vertexProvider.test.ts#L184)).
- Anything the mapping cannot classify becomes `PROVIDER_ERROR`, so an SDK error never reaches the caller as a raw `Error` ([validated by: falls back to PROVIDER_ERROR for a failure it cannot classify](../../src/providers/vertex/vertexProvider.test.ts#L195)).
- A rejection that is not an `Error` at all becomes `PROVIDER_ERROR` with the message `Unknown Vertex AI error` ([validated by: maps a rejection that is no Error, the string 'boom', to PROVIDER_ERROR naming an unknown Vertex AI error](../../src/providers/vertex/vertexProvider.test.ts#L148)).
- The mapping is shared: a failure raised during `generateStructured` is classified exactly as the same failure during `sendMessage` would be ([validated by: throws mapped AIError on Vertex API failure](../../src/providers/vertex/vertexProvider.test.ts#L492)).

## OpenAI

<!-- doc-block: none -- a composed provider configuration; its fields are checked through src/config.ts by typecheck -->
```typescript
const engine = createHalEngine({
  provider: {
    type: 'openai',
    apiKey: requireEnv('OPENAI_API_KEY'),
    model: 'gpt-4o',
    maxTokens: 4096,
  },
  // ...
});
```

**Credentials:**

```bash
OPENAI_API_KEY=sk-...
```

This package reads it nowhere. The configuration example above passes it, so it is your code that reads the variable and this package that receives the value as `apiKey`.

## Anthropic (Direct API)

Connects to Anthropic's API directly, bypassing Bedrock.

<!-- doc-block: none -- a composed provider configuration; its fields are checked through src/config.ts by typecheck -->
```typescript
const engine = createHalEngine({
  provider: {
    type: 'anthropic',
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-6',
    maxTokens: 4096,
  },
  // ...
});
```

**Credentials:**

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

This package reads it nowhere, for the same reason: the example above passes it as `apiKey`.

## Mock Provider

Echoes the user back instead of calling a model. Use for testing, development, and CI -- it needs no credentials, which is why `example/server.ts` runs on it.

<!-- doc-block: none -- a composed provider configuration; its fields are checked through src/config.ts by typecheck -->
```typescript
const engine = createHalEngine({
  provider: {type: 'mock'},
  // ...
});
```

- `sendMessage` streams `Mock response to: "<last user message>"` one word at a time ([validated by: streams word-by-word response echoing user input](../../src/providers/mock/mockProvider.test.ts#L7)).
- The stream closes with a `stop` chunk carrying fixed usage metadata, so usage plumbing can be exercised without a real provider ([validated by: ends with stop chunk containing usage metadata](../../src/providers/mock/mockProvider.test.ts#L16)).
- A last message whose content is not a string falls back to `Hello` rather than failing ([validated by: handles non-string content in last message](../../src/providers/mock/mockProvider.test.ts#L28)).

`generateStructured` is the configurable half. `structuredResponses` maps a user message to the exact object to return for it; anything unmatched gets a value built from the response schema's shape.

<!-- doc-block: none -- a standalone createProvider call, shown beside the createHalEngine form above it -->
```typescript
const provider = createProvider({
  type: 'mock',
  structuredResponses: new Map([['evaluate this', {score: 91, feedback: 'solid'}]]),
});
```

- A matching key returns that object verbatim ([validated by: returns preconfigured response when user text matches](../../src/providers/mock/mockProvider.test.ts#L78)).
- No match returns the schema's default shape: `''` for a string, `0` for a number, `false` for a boolean, `[]` for an array, and recursively for an object ([validated by: returns default values matching schema shape](../../src/providers/mock/mockProvider.test.ts#L72)).
- A `structuredResponses` map that holds no entry for this message falls back to the same default shape, rather than failing or returning nothing ([validated by: falls back to default when no preconfigured response matches](../../src/providers/mock/mockProvider.test.ts#L114)).
- A schema whose top level is not an object is built from the scalar table directly, so a top-level `array` schema returns `[]` ([validated by: returns empty array for array schema](../../src/providers/mock/mockProvider.test.ts#L87)).
- Each caller gets its own array, so one caller mutating a returned `[]` cannot affect another ([validated by: gives each caller its own array, so one mutating it cannot affect another](../../src/providers/mock/mockProvider.test.ts#L98)).

There is no `responses` array and no cycling: the only knob is `structuredResponses`.

Both entry points honour it: the example above goes through `createProvider`, which once called `createMockProvider()` with no arguments and dropped the map ([validated by: forwards MockConfig, so a configured structured response survives the factory](../../src/providers/providerFactory.test.ts#L17)).

It configures `generateStructured` only, and nothing inside `createHalEngine` calls that method - the orchestrator drives `sendMessage`. A consumer who sets `structuredResponses` and drives the engine over HTTP or a WebSocket will see mock chat responses and never a configured object; the map is for code calling the provider directly.

## Cancellation

`SendMessageParams.signal` is how the engine tells a provider to stop. The field is optional, so a provider written before it existed still compiles and behaves as it did, and `withRetry` passes one on every attempt (specs/hal-engine-architecture/spec.md § Provider resilience). Once the signal aborts, a provider yields nothing more and ends its stream without raising: an abort is the engine's own decision, not a vendor failure, and an `AIError` would reach the client as an error frame it did not earn. What an abort stops at the vendor depends on its SDK; [docs/implementing-a-provider.md](../../docs/implementing-a-provider.md) § Cancellation records it per provider and SDK version, with what that means for where personal data goes.

**Bedrock** closes the request at the vendor:

- `params.signal` is passed to `client.send` as its `abortSignal`, the exact object given ([validated by: passes params.signal to client.send as its abortSignal, the exact object it was given](../../src/providers/bedrock/bedrockProvider.test.ts#L52)).
- With no signal, `client.send` receives the command alone, exactly as before the field existed ([validated by: calls client.send with the command alone when no signal is given](../../src/providers/bedrock/bedrockProvider.test.ts#L90)).
- An abort while the request is in flight ends the stream with no chunk and no `AIError`, although the SDK rejects the call, and is logged at `info` as `request aborted` under the provider's name with no other field ([validated by: ends the stream without an AIError when its signal aborts the request in flight, logging only that it aborted](../../src/providers/bedrock/bedrockProvider.test.ts#L99)).
- Events already received are not read after an abort, so a consumer that aborts after the first of three chunks receives one ([validated by: yields nothing further once its signal aborts mid-stream, so an abort after the first of three leaves one](../../src/providers/bedrock/bedrockProvider.test.ts#L130)).
- A signal already aborted when `sendMessage` is called sends nothing to the vendor ([validated by: sends nothing to Bedrock when its signal is already aborted](../../src/providers/bedrock/bedrockProvider.test.ts#L138)).

**Vertex** closes the request at the transport. `@google/genai` hands the signal to `fetch`, so an abort closes the connection and no more of the answer reaches the engine. Measured on 2026-10-19 with `@google/genai` 2.26.0 against `gemini-3.1-flash-lite` on the `eu` multi-region: an abort after the first chunk aborted the signal the SDK gave `fetch`, the next read of the response body raised `AbortError`, and 0 bytes arrived after the abort. The SDK documents that the service may still finish generating, and bill, a request the client aborted. Under `@google-cloud/vertexai` an abort only stopped the engine's reading, and the vendor's response ran to its end.

- `params.signal` reaches the SDK as the request's `abortSignal`, the exact object given ([validated by: hands its abort signal to the SDK, so an abort closes the request rather than only the read](../../src/providers/vertex/vertexProvider.test.ts#L298)).
- The signal is checked between chunks as well, so a consumer that aborts after the first of three receives exactly one ([validated by: stops yielding once its signal aborts between chunks, so an abort after the first of three leaves one](../../src/providers/vertex/vertexProvider.test.ts#L243)).
- A stream that fails after its signal aborted, which is what the closed connection produces, ends quietly, with no `AIError` ([validated by: raises no AIError when the stream fails after its signal aborted](../../src/providers/vertex/vertexProvider.test.ts#L251)).
- A signal already aborted when `sendMessage` is called sends nothing to the vendor ([validated by: sends nothing to Vertex when its signal is already aborted](../../src/providers/vertex/vertexProvider.test.ts#L262)).
- A stream that fails mid-way raises one `PROVIDER_ERROR` after the chunks already read, and leaves no unhandled rejection. `@google/genai` raises the failure from the stream itself and keeps no second copy of the response, so the rejection handler `@google-cloud/vertexai`'s drained copy needed is gone ([validated by: raises one PROVIDER_ERROR after the chunk already read when the stream fails mid-way, and no unhandled rejection](../../src/providers/vertex/vertexProvider.test.ts#L270)).

**Mock** stops at once: an abort after two words leaves two chunks and no `stop` chunk ([validated by: stops yielding once its signal aborts, so an abort after two words leaves two chunks and no stop chunk](../../src/providers/mock/mockProvider.test.ts#L42)).

## Implementing a Custom Provider

To add a new provider, implement the `AIProvider` interface and wire it into the provider factory.

### Step 1: Implement the interface

Create a new file under `src/providers/<name>/`:

<!-- doc-block: none -- a custom provider a reader writes, deliberately outside this package -->
```typescript
// src/providers/custom/customProvider.ts

import type {AIProvider, SendMessageParams, StructuredOutputParams, MessageChunk} from '../../types/ai.js';

export interface CustomConfig {
  type: 'custom';
  apiKey: string;
  modelId: string;
  maxTokens?: number;
  temperature?: number;
}

export function createCustomProvider(config: CustomConfig): AIProvider {
  return {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      const {messages, systemPrompt, tools, signal} = params;

      // An aborted signal sends nothing: the engine has stopped listening
      if (signal?.aborted) return;

      // 1. Map hal-engine messages to your provider's format
      const providerMessages = mapMessages(messages);

      // 2. Call your provider's streaming API, handing it the signal so an abort stops the vendor too
      const stream = await callProviderAPI(
        {
          model: config.modelId,
          messages: providerMessages,
          system: systemPrompt,
          tools: tools?.map(mapToolDefinition),
          max_tokens: config.maxTokens ?? 4096,
          temperature: config.temperature ?? 0.7,
        },
        {signal}
      );

      // 3. Yield MessageChunk objects as they arrive, and nothing once the signal aborts
      for await (const event of stream) {
        if (signal?.aborted) return;

        if (event.type === 'text') {
          yield {type: 'text', text: event.content};
        }

        if (event.type === 'tool_call') {
          yield {
            type: 'tool_use',
            toolCall: {
              id: event.id,
              name: event.name,
              input: event.input,
            },
          };
        }

        if (event.type === 'done') {
          yield {type: 'stop', stopReason: event.reason};
        }
      }
    },

    async generateStructured<T>(params: StructuredOutputParams<T>): Promise<T> {
      // Call your provider's non-streaming API with JSON schema
      const result = await callProviderAPI({
        model: config.modelId,
        messages: mapMessages(params.messages),
        system: params.systemPrompt,
        response_format: {type: 'json_schema', schema: params.responseSchema},
      });
      return JSON.parse(result.content) as T;
    },
  };
}
```

An SDK that cancels a request usually rejects the pending call when the signal aborts. Catch that and return when `signal.aborted` is set, as the Bedrock provider does: an abort must end the stream, not raise an `AIError` (§ Cancellation).

### Step 2: Export from an index file

<!-- doc-block: none -- the barrel file for the custom provider a reader writes -->
```typescript
// src/providers/custom/index.ts
export {createCustomProvider} from './customProvider.js';
export type {CustomConfig} from './customProvider.js';
```

### Step 3: Register in the provider factory

Open `src/providers/providerFactory.ts` and add your provider:

<!-- doc-block: none -- a factory arm a reader adds for their own provider -->
```typescript
import {createCustomProvider} from './custom/index.js';
import type {CustomConfig} from './custom/index.js';

export type ProviderConfig = BedrockConfig | VertexConfig | OpenAIConfig | AnthropicConfig | MockConfig | CustomConfig; // add here

// Each config carries its own `type` literal, which is what the switch narrows on.

export function createProvider(config: ProviderConfig): AIProvider {
  switch (config.type) {
    // ... existing cases ...
    case 'custom':
      return createCustomProvider(config);
  }
}
```

### Step 4: Export from the package root

Open `src/index.ts` and add:

<!-- doc-block: none -- a re-export a reader adds for their own provider -->
```typescript
export {createCustomProvider} from './providers/custom/index.js';
export type {CustomConfig} from './providers/custom/index.js';
```

### The MessageChunk contract

Your provider must yield these chunk types:

| Chunk type                                                  | When to yield                       | Required fields                                                                 |
| ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `{type: 'text', text: string}`                              | For each text token/fragment        | `text`                                                                          |
| `{type: 'tool_use', toolCall: ToolCall}`                    | When the model requests a tool call | `toolCall.id`, `toolCall.name`, `toolCall.input`; optional `toolCall.signature` |
| `{type: 'stop', stopReason: string, usage?: UsageMetadata}` | When the model finishes             | `stopReason` (`'end_turn'` or `'tool_use'`), optional `usage`                   |

The orchestrator handles `tool_use` stop reasons by executing tools and re-calling your provider with the results appended to messages. Your provider does not need to implement the tool loop -- just yield the chunks and the orchestrator handles the rest.

If your vendor attaches a token to a call that it needs back, as Gemini does with `thoughtSignature`, put it on `toolCall.signature`. The orchestrator returns it on that call's `tool_use` block in the turn's next request, and your message mapper sends it back. A provider that never sets it can ignore the field.

## Switching Providers

Because all providers implement the same interface, switching is a config-only change - for `sendMessage`. It is not, for `generateStructured`: Bedrock's throws and Vertex's does not, so an application calling it can move Bedrock to Vertex but not the reverse. Nothing catches that at compile time, because a provider satisfies `AIProvider` by throwing. `README.md` scores each provider per method.

<!-- doc-block: none -- three configurations contrasted to show what switching provider costs -->
```typescript
// Development: use mock
const devEngine = createHalEngine({
  provider: {type: 'mock'},
  // ...
});

// Staging: use Vertex
const stagingEngine = createHalEngine({
  provider: {type: 'vertex', projectId: 'my-project', location: 'europe-west4', modelId: 'gemini-2.5-flash'},
  // ...
});

// Production: use Bedrock
const prodEngine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: 4096,
  },
  // ...
});
```

No code changes needed -- just swap the config.
