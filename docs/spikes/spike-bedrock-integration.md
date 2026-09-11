# Spike: AWS Bedrock Integration with TypeScript


## Context
The team needs to integrate with AWS Bedrock to:
- Send user messages and receive AI responses
- Stream responses for real-time UI updates
- Support tool calling (AI requests tool execution)
- Handle the multi-turn tool calling flow
- Manage token limits and context windows
- Handle errors and implement retries

Requirements from team meeting:
- Create an abstraction layer over Bedrock
- Should be swappable for other providers later
- Need to understand streaming vs non-streaming trade-offs
- Converse API is newer and recommended for conversations

---

## Decision: Converse API vs InvokeModel

**Recommendation: Use Converse API**

| Aspect | Converse API | InvokeModel |
|--------|--------------|-------------|
| Interface | Unified across all models | Model-specific payloads |
| Tool calling | Built-in support | Manual implementation |
| Streaming | `ConverseStreamCommand` | `InvokeModelWithResponseStream` |
| Maintenance | Write once, use any model | Different code per model |
| Future-proof | AWS recommended | Legacy approach |

The Converse API provides a consistent interface that works with all Bedrock models supporting messages. You write code once and can swap models without code changes.

### Streaming Operations
- `Converse` - Non-streaming, synchronous response
- `ConverseStream` - Streaming, real-time chunks

### Required Permissions
- `bedrock:InvokeModel` for Converse
- `bedrock:InvokeModelWithResponseStream` for ConverseStream

---

## Token Limits Reference

| Model | Context Window | Max Output | Notes |
|-------|----------------|------------|-------|
| Claude 3 Opus | 200K | 4K | Most capable |
| Claude 3 Sonnet | 200K | 4K | Balanced |
| Claude 3 Haiku | 200K | 4K | Fastest/cheapest |
| Claude 3.5 Sonnet | 200K | 8K | Improved reasoning |
| Claude 3.7 Sonnet | 200K | 128K | 64K GA, 64-128K beta |
| Claude Sonnet 4 | 200K (1M beta) | 64K | Latest |
| Claude 4.5 Sonnet | 200K (1M beta) | 64K | Latest |

### Extended Context (1M tokens)
- Available for Sonnet 4 and 4.5 only
- Requires header: `anthropic_beta: ["context-1m-2025-08-07"]`
- Requires organization tier 4
- Premium pricing: 2x input, 1.5x output for requests >200K tokens

### Validation Behavior
With Claude 3.7+, `max_tokens` is enforced strictly. The system returns a validation error if `prompt_tokens + max_tokens > context_window`.

---

## Cost Analysis

### On-Demand Pricing (per 1,000 tokens)

| Model | Input | Output | Notes |
|-------|-------|--------|-------|
| Claude 3 Haiku | $0.00025 | $0.00125 | Best for high-volume |
| Claude 3.5 Haiku | $0.001 | $0.005 | Latency-optimized mode |
| Claude 3 Sonnet | $0.003 | $0.015 | Balanced |
| Claude 3.5 Sonnet v2 | $0.006 | $0.03 | Current production choice |
| Claude Sonnet 4 | $0.003 | $0.015 | Latest |

### Batch Pricing (50% discount)
- Claude 3.5 Sonnet v2: $0.003 input, $0.015 output
- Claude 3.5 Haiku: $0.0005 input, $0.0025 output

### Prompt Caching (Claude 3.5 Sonnet v2)
- Cache write: $0.0075 per 1K tokens
- Cache read: $0.0006 per 1K tokens
- Significant savings for repeated context

### Regional Pricing
- Regional endpoints include 10% premium over global endpoints
- Consider eu-west-1 for best pricing

### Cost Estimation Example
For a typical chat session (1,000 input + 500 output tokens):

| Model | Input Cost | Output Cost | Per Message | 1,000 msgs/day |
|-------|------------|-------------|-------------|----------------|
| Claude 3 Haiku | $0.00025 | $0.000625 | **$0.0009** | **$0.90/day** |
| Claude 3.5 Haiku | $0.001 | $0.0025 | **$0.0035** | **$3.50/day** |
| Claude Sonnet 4 | $0.003 | $0.0075 | **$0.011** | **$11/day** |
| Claude 3.5 Sonnet v2 | $0.006 | $0.015 | **$0.021** | **$21/day** |

**Recommendation**: Start with Claude 3 Haiku for most chat interactions. Use Sonnet only for complex reasoning tasks.

---

## Risk Assessment

### High Priority Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Throttling limits** | Service disruption | Implement exponential backoff with jitter; pre-emptive rate limiting |
| **Cost overruns** | Budget exceeded | Set CloudWatch alarms; implement token counting; use cheaper models for simple tasks |
| **Streaming error recovery** | Incomplete responses | Buffer partial responses; implement reconnection logic |
| **Tool calling loops** | Infinite loops | Set max iterations; timeout handling |

### Medium Priority Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **1M context is beta** | Feature instability | Use standard 200K for production; plan for fallback |
| **Model deprecation** | Breaking changes | Use abstraction layer; monitor AWS announcements |
| **Regional availability** | Limited regions | Use cross-region inference profiles |
| **Latency variability** | Poor UX | Streaming for immediate feedback; loading states |

### Low Priority Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **SDK breaking changes** | Update needed | Pin versions; test in staging |
| **New model versions** | Testing overhead | Automated model comparison tests |

### Security Considerations
- Never log full prompts/responses (PII risk)
- Use IAM roles with least privilege
- Enable CloudTrail for audit logging
- Consider guardrails for content filtering

---

## Dependencies

### Required Packages
```json
{
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.x",
    "@aws-sdk/middleware-retry": "^3.x"
  },
  "devDependencies": {
    "@types/node": "^20.x"
  }
}
```

### Environment Variables
```bash
# Required
AWS_REGION=eu-west-1
AWS_ACCESS_KEY_ID=<from-environment>
AWS_SECRET_ACCESS_KEY=<from-environment>

# Optional
BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0
BEDROCK_MAX_TOKENS=4096
BEDROCK_TEMPERATURE=0.7
```

### IAM Permissions Required
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
      ]
    }
  ]
}
```

---

## Code Snippets

### 1. Client Initialization with Retry

```typescript
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  ConversationRole,
} from '@aws-sdk/client-bedrock-runtime';
import {StandardRetryStrategy} from '@aws-sdk/middleware-retry';

const MAXIMUM_ATTEMPTS = 6;
const MAXIMUM_RETRY_DELAY = 10_000;

const customRetryStrategy = new StandardRetryStrategy(async () => MAXIMUM_ATTEMPTS, {
  delayDecider: (_, attempts) => Math.floor(Math.min(MAXIMUM_RETRY_DELAY, Math.random() * 2 ** attempts * 1100)),
});

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? 'eu-west-1',
  maxAttempts: MAXIMUM_ATTEMPTS,
  retryStrategy: customRetryStrategy,
});
```

### 2. Streaming Response Handling

```typescript
import {BedrockRuntimeClient, ConverseStreamCommand, Message, ContentBlock} from '@aws-sdk/client-bedrock-runtime';

interface StreamChunk {
  type: 'text' | 'tool_use' | 'message_start' | 'message_stop' | 'metadata';
  content?: string;
  toolUse?: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
  stopReason?: string;
  usage?: {inputTokens: number; outputTokens: number};
}

async function* streamConversation(
  client: BedrockRuntimeClient,
  modelId: string,
  messages: Message[],
  systemPrompt: string,
  toolConfig?: ToolConfiguration
): AsyncGenerator<StreamChunk> {
  const command = new ConverseStreamCommand({
    modelId,
    messages,
    system: [{text: systemPrompt}],
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0.7,
      topP: 0.9,
    },
    toolConfig,
  });

  const response = await client.send(command);

  for await (const event of response.stream!) {
    if (event.messageStart) {
      yield {type: 'message_start'};
    }

    if (event.contentBlockDelta?.delta?.text) {
      yield {
        type: 'text',
        content: event.contentBlockDelta.delta.text,
      };
    }

    if (event.contentBlockStart?.start?.toolUse) {
      const toolUse = event.contentBlockStart.start.toolUse;
      yield {
        type: 'tool_use',
        toolUse: {
          toolUseId: toolUse.toolUseId!,
          name: toolUse.name!,
          input: {},
        },
      };
    }

    if (event.messageStop) {
      yield {
        type: 'message_stop',
        stopReason: event.messageStop.stopReason,
      };
    }

    if (event.metadata) {
      yield {
        type: 'metadata',
        usage: {
          inputTokens: event.metadata.usage?.inputTokens ?? 0,
          outputTokens: event.metadata.usage?.outputTokens ?? 0,
        },
      };
    }
  }
}

// Usage with WebSocket
async function handleStreamToWebSocket(ws: WebSocket, messages: Message[]) {
  const stream = streamConversation(
    client,
    'anthropic.claude-3-sonnet-20240229-v1:0',
    messages,
    'You are a helpful assistant.'
  );

  for await (const chunk of stream) {
    if (chunk.type === 'text') {
      ws.send(JSON.stringify({type: 'assistant_chunk', content: chunk.content}));
    }
    if (chunk.type === 'message_stop') {
      ws.send(JSON.stringify({type: 'assistant_done', stopReason: chunk.stopReason}));
    }
  }
}
```

### 3. Tool Calling Flow

```typescript
import {
  BedrockRuntimeClient,
  ConverseCommand,
  Message,
  ToolConfiguration,
  ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

// Step 1: Define tools
const toolConfig: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'get_weather',
        description: 'Get current weather for a location',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'City name or coordinates',
              },
              units: {
                type: 'string',
                enum: ['celsius', 'fahrenheit'],
                description: 'Temperature units',
              },
            },
            required: ['location'],
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'search_database',
        description: 'Search the application database',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: {type: 'string', description: 'Search query'},
              filters: {
                type: 'object',
                properties: {
                  category: {type: 'string'},
                  minScore: {type: 'number'},
                },
              },
            },
            required: ['query'],
          },
        },
      },
    },
  ],
};

// Step 2: Tool execution registry
type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  get_weather: async input => {
    const {location, units = 'celsius'} = input as {location: string; units?: string};
    // Call weather API
    return {temperature: 22, condition: 'sunny', location, units};
  },
  search_database: async input => {
    const {query, filters} = input as {query: string; filters?: Record<string, unknown>};
    // Query database
    return {results: [], totalCount: 0};
  },
};

// Step 3: Complete tool calling loop
async function converseWithTools(
  client: BedrockRuntimeClient,
  modelId: string,
  initialMessage: string,
  systemPrompt: string,
  maxIterations = 10
): Promise<string> {
  const messages: Message[] = [{role: 'user', content: [{text: initialMessage}]}];

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        messages,
        system: [{text: systemPrompt}],
        toolConfig,
      })
    );

    const assistantMessage = response.output!.message!;
    messages.push(assistantMessage);

    if (response.stopReason === 'tool_use') {
      const toolResults: ContentBlock[] = [];

      for (const block of assistantMessage.content!) {
        if ('toolUse' in block && block.toolUse) {
          const {toolUseId, name, input} = block.toolUse;
          const handler = toolHandlers[name!];

          if (handler) {
            try {
              const result = await handler(input as Record<string, unknown>);
              toolResults.push({
                toolResult: {
                  toolUseId: toolUseId!,
                  content: [{json: result}],
                },
              });
            } catch (error) {
              toolResults.push({
                toolResult: {
                  toolUseId: toolUseId!,
                  status: 'error',
                  content: [{text: `Tool error: ${(error as Error).message}`}],
                },
              });
            }
          }
        }
      }

      messages.push({role: 'user', content: toolResults});
      continue;
    }

    if (response.stopReason === 'end_turn' || response.stopReason === 'max_tokens') {
      const textContent = assistantMessage.content?.find(b => 'text' in b);
      return textContent && 'text' in textContent ? textContent.text! : '';
    }
  }

  throw new Error('Max tool iterations exceeded');
}
```

### 4. Error Handling

```typescript
import {
  ThrottlingException,
  ServiceUnavailableException,
  ModelTimeoutException,
  ModelNotReadyException,
  ValidationException,
  AccessDeniedException,
} from '@aws-sdk/client-bedrock-runtime';

interface BedrockError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

function classifyError(error: unknown): BedrockError {
  if (error instanceof ThrottlingException) {
    return {
      code: 'THROTTLING',
      message: 'Rate limit exceeded',
      retryable: true,
      retryAfterMs: 60_000,
    };
  }

  if (error instanceof ServiceUnavailableException) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service temporarily unavailable',
      retryable: true,
      retryAfterMs: 5_000,
    };
  }

  if (error instanceof ModelTimeoutException) {
    return {
      code: 'TIMEOUT',
      message: 'Model response timeout',
      retryable: true,
      retryAfterMs: 1_000,
    };
  }

  if (error instanceof ModelNotReadyException) {
    return {
      code: 'MODEL_NOT_READY',
      message: 'Model is warming up',
      retryable: true,
      retryAfterMs: 30_000,
    };
  }

  if (error instanceof ValidationException) {
    return {
      code: 'VALIDATION_ERROR',
      message: (error as Error).message,
      retryable: false,
    };
  }

  if (error instanceof AccessDeniedException) {
    return {
      code: 'ACCESS_DENIED',
      message: 'Missing bedrock:InvokeModel permission',
      retryable: false,
    };
  }

  return {
    code: 'UNKNOWN',
    message: (error as Error).message ?? 'Unknown error',
    retryable: false,
  };
}

async function withRetry<T>(operation: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const classified = classifyError(error);

      if (!classified.retryable || attempt === maxAttempts) {
        throw error;
      }

      const baseDelay = classified.retryAfterMs ?? Math.min(20_000, 2 ** attempt * 1000);
      const jitter = Math.random() * 1000;
      const delay = baseDelay + jitter;

      console.warn(`Attempt ${attempt} failed: ${classified.code}. Retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

### 5. Provider-Agnostic Abstraction Layer

```typescript
// types/ai-provider.ts
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AIContentBlock[];
}

export interface AIContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
}

export interface AIToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AIStreamChunk {
  type: 'text' | 'tool_use_start' | 'tool_use_delta' | 'done' | 'error';
  content?: string;
  toolUse?: {id: string; name: string; input: Record<string, unknown>};
  stopReason?: string;
  error?: string;
}

export interface AIProviderConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface AIProvider {
  sendMessage(messages: AIMessage[], config?: AIProviderConfig): Promise<AIMessage>;

  streamMessage(messages: AIMessage[], config?: AIProviderConfig): AsyncGenerator<AIStreamChunk>;

  sendWithTools(
    messages: AIMessage[],
    tools: AIToolDefinition[],
    toolExecutor: (name: string, input: Record<string, unknown>) => Promise<unknown>,
    config?: AIProviderConfig
  ): Promise<AIMessage>;
}

// providers/bedrock-provider.ts
export class BedrockProvider implements AIProvider {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private systemPrompt: string;

  constructor(config: {region: string; modelId: string; systemPrompt?: string}) {
    this.client = new BedrockRuntimeClient({region: config.region});
    this.modelId = config.modelId;
    this.systemPrompt = config.systemPrompt ?? '';
  }

  async sendMessage(messages: AIMessage[], config?: AIProviderConfig): Promise<AIMessage> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        messages: this.toBedrockMessages(messages),
        system: this.systemPrompt ? [{text: this.systemPrompt}] : undefined,
        inferenceConfig: {
          maxTokens: config?.maxTokens ?? 4096,
          temperature: config?.temperature ?? 0.7,
          topP: config?.topP,
        },
      })
    );

    return this.fromBedrockMessage(response.output!.message!);
  }

  async *streamMessage(messages: AIMessage[], config?: AIProviderConfig): AsyncGenerator<AIStreamChunk> {
    const response = await this.client.send(
      new ConverseStreamCommand({
        modelId: this.modelId,
        messages: this.toBedrockMessages(messages),
        system: this.systemPrompt ? [{text: this.systemPrompt}] : undefined,
        inferenceConfig: {
          maxTokens: config?.maxTokens ?? 4096,
          temperature: config?.temperature ?? 0.7,
          topP: config?.topP,
        },
      })
    );

    for await (const event of response.stream!) {
      if (event.contentBlockDelta?.delta?.text) {
        yield {type: 'text', content: event.contentBlockDelta.delta.text};
      }
      if (event.messageStop) {
        yield {type: 'done', stopReason: event.messageStop.stopReason};
      }
    }
  }

  async sendWithTools(
    messages: AIMessage[],
    tools: AIToolDefinition[],
    toolExecutor: (name: string, input: Record<string, unknown>) => Promise<unknown>,
    config?: AIProviderConfig
  ): Promise<AIMessage> {
    // Implementation follows tool calling flow pattern above
    throw new Error('Not implemented - see tool calling flow section');
  }

  private toBedrockMessages(messages: AIMessage[]): Message[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? [{text: m.content}] : this.toBedrockContent(m.content),
      }));
  }

  private toBedrockContent(blocks: AIContentBlock[]): ContentBlock[] {
    return blocks.map(b => {
      if (b.type === 'text') return {text: b.text!};
      if (b.type === 'tool_result') {
        return {toolResult: {toolUseId: b.toolUseId!, content: [{json: b.toolResult}]}};
      }
      throw new Error(`Unsupported block type: ${b.type}`);
    });
  }

  private fromBedrockMessage(message: Message): AIMessage {
    return {
      role: message.role as 'user' | 'assistant',
      content: message.content!.map(b => {
        if ('text' in b) return {type: 'text' as const, text: b.text};
        if ('toolUse' in b && b.toolUse) {
          return {
            type: 'tool_use' as const,
            toolUseId: b.toolUse.toolUseId,
            toolName: b.toolUse.name,
            toolInput: b.toolUse.input as Record<string, unknown>,
          };
        }
        throw new Error('Unknown content block type');
      }),
    };
  }
}

// Usage - easily swappable
const provider: AIProvider = new BedrockProvider({
  region: 'eu-west-1',
  modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  systemPrompt: 'You are a helpful assistant.',
});

// Later: swap to another provider
// const provider: AIProvider = new OpenAIProvider({ ... });
```

---

## Stream Events Reference

Events emitted by `ConverseStreamCommand` in order:

| Event | Field | Content |
|-------|-------|---------|
| `messageStart` | `role` | 'assistant' |
| `contentBlockStart` | `start.toolUse` | Tool use metadata (if tool call) |
| `contentBlockDelta` | `delta.text` | Partial text content |
| `contentBlockDelta` | `delta.toolUse` | Partial tool input JSON |
| `contentBlockStop` | - | End of content block |
| `messageStop` | `stopReason` | 'end_turn', 'tool_use', 'max_tokens' |
| `metadata` | `usage`, `metrics` | Token counts, latency |

---

## References

### AWS Documentation
- [Converse API Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [ConverseStream API Reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)
- [Tool Use Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use.html)
- [Tool Calling Inference](https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use-inference-call.html)
- [JavaScript SDK Examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html)
- [Retry Behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
- [Throttling Troubleshooting](https://repost.aws/knowledge-center/bedrock-throttling-error)
- [Claude Token Limits](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html)
- [Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/)

### Code Samples
- [AWS Streaming Sample Repo](https://github.com/aws-samples/stream-ai-assistant-using-bedrock-converse-with-tools)
- [@aws-sdk/client-bedrock-runtime npm](https://www.npmjs.com/package/@aws-sdk/client-bedrock-runtime)

### Anthropic
- [Claude Context Windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
- [Claude Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

---

## Conclusion

The Converse API is the recommended approach for AWS Bedrock integration:
- Unified interface across all models
- Built-in streaming and tool calling support
- Write once, swap models easily
- Provider abstraction enables future flexibility

Next steps:
1. Add dependencies to `package.json`
2. Implement `BedrockProvider` class
3. Set up environment variables
4. Create integration tests
