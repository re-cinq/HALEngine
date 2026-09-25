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
| Google Vertex AI   | `'vertex'`    | `@google-cloud/vertexai`          |
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

See [spike-bedrock-integration.md](../../docs/spikes/spike-bedrock-integration.md) for detailed cost analysis, token limits, and error handling patterns.

## Google Vertex AI

Supports streaming through `sendMessage` and structured JSON output through `generateStructured` ([validated by: streams text chunks from Vertex AI response](../../src/providers/vertex/vertexProvider.test.ts#L60), [structured](../../src/providers/vertex/vertexProvider.test.ts#L213)).

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
    // EU multi-region only — location alone cannot reach it. The endpoint decides
    // where the request goes, so this line works with any EU location value:
    // apiEndpoint: 'aiplatform.eu.rep.googleapis.com',
  },
  // ...
});
```

Measured on 2026-09-25 against project `re5-n8n-platform`, one `generateContent` call per cell: `gemini-3.1-flash-lite` answers on `aiplatform.eu.rep.googleapis.com` with `location` set to either `eu` or `europe-west4`, and returns 404 on the `europe-west4` regional host. The host routes; the `location` segment does not override it. So a reader who uncomments `apiEndpoint` without touching `location` gets the EU multi-region, which is the point of the field.

`location` selects the regional endpoint, so it decides where the request is processed and which jurisdiction the data stays in - not merely which datacentre is nearest. It is passed straight to `new VertexAI({location})` and the engine does not validate it: a region that does not serve the model surfaces as a vendor error on the first call, not at construction. The examples here use `europe-west4`.

The `eu` multi-region is a distinct host (`aiplatform.eu.rep.googleapis.com`) rather than a `location` value, and `@google-cloud/vertexai` derives its endpoint from `location` unless given one, so `location` alone cannot reach it. The optional `apiEndpoint` on `VertexConfig` is forwarded verbatim to `new VertexAI({apiEndpoint})`, and when it is absent no endpoint override is passed, so single-region deployments are byte-for-byte unchanged ([validated by: forwards apiEndpoint to the VertexAI constructor for the eu multi-region](../../src/providers/vertex/vertexProvider.test.ts#L297), [omits apiEndpoint when unset so single-region deployments are unchanged](../../src/providers/vertex/vertexProvider.test.ts#L309)).

**Credentials:**

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

This package reads neither. `src/providers/vertex/vertexProvider.ts:33` constructs `new VertexAI({project, location, googleAuthOptions})` and Google's auth library resolves credentials itself, from `googleAuthOptions`, that variable, or the metadata server. `projectId` is the config field above, not `GOOGLE_CLOUD_PROJECT`: setting the variable and passing a different `projectId` gives you the config value with no warning.

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

- A function call part becomes a `tool_use` chunk. Vertex reports no call id of its own, so the function's name is used as the id as well ([validated by: yields tool_use chunks for function calls](../../src/providers/vertex/vertexProvider.test.ts#L81)).
- A `MAX_TOKENS` finish reason becomes the stop reason `max_tokens`, so a truncated reply is distinguishable from a completed one ([validated by: maps MAX_TOKENS finish reason](../../src/providers/vertex/vertexProvider.test.ts#L115)).
- A candidate carrying no parts is skipped rather than emitted as an empty chunk ([validated by: skips chunks with no candidate parts](../../src/providers/vertex/vertexProvider.test.ts#L163)).
- The `assistant` role is sent to Vertex as `model`, which is the only role name its API accepts for a prior reply; `user` passes through unchanged ([validated by: maps assistant role to model for Vertex API](../../src/providers/vertex/vertexProvider.test.ts#L180)).

### Structured output

- `generateStructured` sets `responseMimeType` to `application/json` and passes the schema with its type names upper-cased, which is the form the Vertex SDK expects ([validated by: configures model with responseMimeType and responseSchema](../../src/providers/vertex/vertexProvider.test.ts#L233)).
- A response body that is not valid JSON raises `AIError` with code `PARSE_ERROR`, rather than returning something the caller would have to re-check ([validated by: throws AIError with PARSE_ERROR on invalid JSON](../../src/providers/vertex/vertexProvider.test.ts#L268)).

### Error mapping

- A message naming `429` or `RESOURCE_EXHAUSTED` becomes `RATE_LIMITED` and is marked retryable ([validated by: throws AIError with RATE_LIMITED on 429](../../src/providers/vertex/vertexProvider.test.ts#L127)).
- A message naming `401`, `403` or `PERMISSION_DENIED` becomes `AUTH_ERROR` ([validated by: throws AIError with AUTH_ERROR on permission denied](../../src/providers/vertex/vertexProvider.test.ts#L139)).
- Anything the mapping cannot classify becomes `PROVIDER_ERROR`, so an SDK error never reaches the caller as a raw `Error` ([validated by: falls back to PROVIDER_ERROR for a failure it cannot classify](../../src/providers/vertex/vertexProvider.test.ts#L151)).
- The mapping is shared: a failure raised during `generateStructured` is classified exactly as the same failure during `sendMessage` would be ([validated by: throws mapped AIError on Vertex API failure](../../src/providers/vertex/vertexProvider.test.ts#L282)).

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

- A matching key returns that object verbatim ([validated by: returns preconfigured response when user text matches](../../src/providers/mock/mockProvider.test.ts#L68)).
- No match returns the schema's default shape: `''` for a string, `0` for a number, `false` for a boolean, `[]` for an array, and recursively for an object ([validated by: returns default values matching schema shape](../../src/providers/mock/mockProvider.test.ts#L62)).
- A `structuredResponses` map that holds no entry for this message falls back to the same default shape, rather than failing or returning nothing ([validated by: falls back to default when no preconfigured response matches](../../src/providers/mock/mockProvider.test.ts#L104)).
- A schema whose top level is not an object is built from the scalar table directly, so a top-level `array` schema returns `[]` ([validated by: returns empty array for array schema](../../src/providers/mock/mockProvider.test.ts#L77)).
- Each caller gets its own array, so one caller mutating a returned `[]` cannot affect another ([validated by: gives each caller its own array, so one mutating it cannot affect another](../../src/providers/mock/mockProvider.test.ts#L88)).

There is no `responses` array and no cycling: the only knob is `structuredResponses`.

Both entry points honour it: the example above goes through `createProvider`, which once called `createMockProvider()` with no arguments and dropped the map ([validated by: forwards MockConfig, so a configured structured response survives the factory](../../src/providers/providerFactory.test.ts#L17)).

It configures `generateStructured` only, and nothing inside `createHalEngine` calls that method - the orchestrator drives `sendMessage`. A consumer who sets `structuredResponses` and drives the engine over HTTP or a WebSocket will see mock chat responses and never a configured object; the map is for code calling the provider directly.

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
      const {messages, systemPrompt, tools} = params;

      // 1. Map hal-engine messages to your provider's format
      const providerMessages = mapMessages(messages);

      // 2. Call your provider's streaming API
      const stream = await callProviderAPI({
        model: config.modelId,
        messages: providerMessages,
        system: systemPrompt,
        tools: tools?.map(mapToolDefinition),
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
      });

      // 3. Yield MessageChunk objects as they arrive
      for await (const event of stream) {
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

| Chunk type                                                  | When to yield                       | Required fields                                               |
| ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| `{type: 'text', text: string}`                              | For each text token/fragment        | `text`                                                        |
| `{type: 'tool_use', toolCall: ToolCall}`                    | When the model requests a tool call | `toolCall.id`, `toolCall.name`, `toolCall.input`              |
| `{type: 'stop', stopReason: string, usage?: UsageMetadata}` | When the model finishes             | `stopReason` (`'end_turn'` or `'tool_use'`), optional `usage` |

The orchestrator handles `tool_use` stop reasons by executing tools and re-calling your provider with the results appended to messages. Your provider does not need to implement the tool loop -- just yield the chunks and the orchestrator handles the rest.

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
