# AI Providers

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

hal-engine ships with built-in support for multiple AI providers. All providers implement the same `AIProvider` interface, so switching between them requires only a configuration change.

## Supported Providers

Implementation status is scored per method in `README.md`, which carries the only such matrix.

| Provider | Type string | Package |
|----------|-------------|---------|
| AWS Bedrock | `'bedrock'` | `@aws-sdk/client-bedrock-runtime` |
| Google Vertex AI | `'vertex'` | `@google-cloud/vertexai` |
| OpenAI | `'openai'` | `openai` |
| Anthropic (Direct) | `'anthropic'` | `@anthropic-ai/sdk` |
| Mock | `'mock'` | (built-in) |

## Configuring a Provider

Pass the provider config to `createHalEngine()` or use `createProvider()` directly:

```typescript
import {createHalEngine} from '@re-cinq/hal-engine';

// Via createHalEngine
const engine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    maxTokens: 4096,
  },
  // ... rest of config
});

// Or standalone
import {createProvider} from '@re-cinq/hal-engine';

const provider = createProvider({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
});
```

## AWS Bedrock

Uses the Converse API for a unified interface across all Bedrock-hosted models.

```typescript
const engine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
    maxTokens: 4096,
  },
  // ...
});
```

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

Supports streaming through `sendMessage` and structured JSON output through `generateStructured` ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L55), [structured](../../src/providers/vertex/vertexProvider.test.ts#L208)).

```typescript
const engine = createHalEngine({
  provider: {
    type: 'vertex',
    projectId: 'my-gcp-project',
    location: 'europe-west4',
    modelId: 'gemini-1.5-pro',
    maxTokens: 4096,
    googleAuthOptions: {
      keyFilename: '/path/to/service-account.json',
    },
  },
  // ...
});
```

`location` selects the regional endpoint, so it decides where the request is processed and which jurisdiction the data stays in - not merely which datacentre is nearest. It is passed straight to `new VertexAI({location})` and the engine does not validate it: a region that does not serve the model surfaces as a vendor error on the first call, not at construction. The examples here use `europe-west4`.

**Credentials:**
```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

This package reads neither. `src/providers/vertex/vertexProvider.ts:33` constructs `new VertexAI({project, location, googleAuthOptions})` and Google's auth library resolves credentials itself, from `googleAuthOptions`, that variable, or the metadata server. `projectId` is the config field above, not `GOOGLE_CLOUD_PROJECT`: setting the variable and passing a different `projectId` gives you the config value with no warning.

**Structured output example:**
```typescript
import {createVertexProvider} from '@re-cinq/hal-engine';

const provider = createVertexProvider({
  type: 'vertex',
  projectId: 'my-project',
  location: 'europe-west4',
  modelId: 'gemini-1.5-flash',
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

- A function call part becomes a `tool_use` chunk. Vertex reports no call id of its own, so the function's name is used as the id as well ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L76)).
- A `MAX_TOKENS` finish reason becomes the stop reason `max_tokens`, so a truncated reply is distinguishable from a completed one ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L110)).
- A candidate carrying no parts is skipped rather than emitted as an empty chunk ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L158)).
- The `assistant` role is sent to Vertex as `model`, which is the only role name its API accepts for a prior reply; `user` passes through unchanged ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L175)).

### Structured output

- `generateStructured` sets `responseMimeType` to `application/json` and passes the schema with its type names upper-cased, which is the form the Vertex SDK expects ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L228)).
- A response body that is not valid JSON raises `AIError` with code `PARSE_ERROR`, rather than returning something the caller would have to re-check ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L263)).

### Error mapping

- A message naming `429` or `RESOURCE_EXHAUSTED` becomes `RATE_LIMITED` and is marked retryable ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L122)).
- A message naming `401`, `403` or `PERMISSION_DENIED` becomes `AUTH_ERROR` ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L134)).
- Anything the mapping cannot classify becomes `PROVIDER_ERROR`, so an SDK error never reaches the caller as a raw `Error` ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L146)).
- The mapping is shared: a failure raised during `generateStructured` is classified exactly as the same failure during `sendMessage` would be ([validated by](../../src/providers/vertex/vertexProvider.test.ts#L277)).

## OpenAI

```typescript
const engine = createHalEngine({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
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

```typescript
const engine = createHalEngine({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-20250514',
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

```typescript
const engine = createHalEngine({
  provider: {type: 'mock'},
  // ...
});
```

- `sendMessage` streams `Mock response to: "<last user message>"` one word at a time ([validated by](../../src/providers/mock/mockProvider.test.ts#L7)).
- The stream closes with a `stop` chunk carrying fixed usage metadata, so usage plumbing can be exercised without a real provider ([validated by](../../src/providers/mock/mockProvider.test.ts#L16)).
- A last message whose content is not a string falls back to `Hello` rather than failing ([validated by](../../src/providers/mock/mockProvider.test.ts#L28)).

`generateStructured` is the configurable half. `structuredResponses` maps a user message to the exact object to return for it; anything unmatched gets a value built from the response schema's shape.

```typescript
const provider = createProvider({
  type: 'mock',
  structuredResponses: new Map([['evaluate this', {score: 91, feedback: 'solid'}]]),
});
```

- A matching key returns that object verbatim ([validated by](../../src/providers/mock/mockProvider.test.ts#L68)).
- No match returns the schema's default shape: `''` for a string, `0` for a number, `false` for a boolean, `[]` for an array, and recursively for an object ([validated by](../../src/providers/mock/mockProvider.test.ts#L62)).
- A `structuredResponses` map that holds no entry for this message falls back to the same default shape, rather than failing or returning nothing ([validated by](../../src/providers/mock/mockProvider.test.ts#L104)).
- A schema whose top level is not an object is built from the scalar table directly, so a top-level `array` schema returns `[]` ([validated by](../../src/providers/mock/mockProvider.test.ts#L77)).
- Each caller gets its own array, so one caller mutating a returned `[]` cannot affect another ([validated by](../../src/providers/mock/mockProvider.test.ts#L88)).

There is no `responses` array and no cycling: the only knob is `structuredResponses`.

Both entry points honour it: the example above goes through `createProvider`, which once called `createMockProvider()` with no arguments and dropped the map ([validated by](../../src/providers/providerFactory.test.ts#L17)).

It configures `generateStructured` only, and nothing inside `createHalEngine` calls that method - the orchestrator drives `sendMessage`. A consumer who sets `structuredResponses` and drives the engine over HTTP or a WebSocket will see mock chat responses and never a configured object; the map is for code calling the provider directly.

## Implementing a Custom Provider

To add a new provider, implement the `AIProvider` interface and wire it into the provider factory.

### Step 1: Implement the interface

Create a new file under `src/providers/<name>/`:

```typescript
// src/providers/custom/customProvider.ts

import type {AIProvider, SendMessageParams, StructuredOutputParams, MessageChunk} from '../../types/ai';

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

```typescript
// src/providers/custom/index.ts
export {createCustomProvider} from './customProvider.js';
export type {CustomConfig} from './customProvider.js';
```

### Step 3: Register in the provider factory

Open `src/providers/providerFactory.ts` and add your provider:

```typescript
import {createCustomProvider} from './custom/index.js';
import type {CustomConfig} from './custom/index.js';

export type ProviderConfig =
  | BedrockConfig
  | VertexConfig
  | OpenAIConfig
  | AnthropicConfig
  | MockConfig
  | CustomConfig;   // add here

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

```typescript
export {createCustomProvider} from './providers/custom/index.js';
export type {CustomConfig} from './providers/custom/index.js';
```

### The MessageChunk contract

Your provider must yield these chunk types:

| Chunk type | When to yield | Required fields |
|------------|---------------|-----------------|
| `{type: 'text', text: string}` | For each text token/fragment | `text` |
| `{type: 'tool_use', toolCall: ToolCall}` | When the model requests a tool call | `toolCall.id`, `toolCall.name`, `toolCall.input` |
| `{type: 'stop', stopReason: string, usage?: UsageMetadata}` | When the model finishes | `stopReason` (`'end_turn'` or `'tool_use'`), optional `usage` |

The orchestrator handles `tool_use` stop reasons by executing tools and re-calling your provider with the results appended to messages. Your provider does not need to implement the tool loop -- just yield the chunks and the orchestrator handles the rest.

## Switching Providers

Because all providers implement the same interface, switching is a config-only change - for `sendMessage`. It is not, for `generateStructured`: Bedrock's throws and Vertex's does not, so an application calling it can move Bedrock to Vertex but not the reverse. Nothing catches that at compile time, because a provider satisfies `AIProvider` by throwing. `README.md` scores each provider per method.

```typescript
// Development: use mock
const devEngine = createHalEngine({
  provider: {type: 'mock', responses: ['Test response']},
  // ...
});

// Staging: use Bedrock with a cheaper model
const stagingEngine = createHalEngine({
  provider: {type: 'bedrock', region: 'eu-west-1', modelId: 'anthropic.claude-3-haiku-20240307-v1:0'},
  // ...
});

// Production: use Bedrock with the best model
const prodEngine = createHalEngine({
  provider: {type: 'bedrock', region: 'eu-west-1', modelId: 'anthropic.claude-sonnet-4-20250514-v1:0'},
  // ...
});
```

No code changes needed -- just swap the config.
