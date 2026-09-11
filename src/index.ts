export {createHalEngine} from './config.js';
export type {HalEngineConfig, HalEngine} from './config.js';

export {createApp} from './transport/createApp.js';
export type {HalAppOptions} from './transport/createApp.js';
export {createServer} from './transport/createServer.js';
export type {HalServerOptions, HalServer} from './transport/createServer.js';
export {createChatRoutes} from './transport/routes/chats.js';

export {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
export type {ChatOrchestrator, ChatOrchestratorOptions, OrchestratorHooks} from './orchestration/chatOrchestrator.js';
export {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
export type {PromptBuilderConfig, PromptBuilderOptions} from './infrastructure/builders/promptBuilder.js';
export {toMessages, createContextConfig} from './orchestration/conversationContext.js';
export type {ContextConfig} from './orchestration/conversationContext.js';

export {createProvider} from './providers/providerFactory.js';
export type {ProviderConfig, ProviderType} from './providers/providerFactory.js';
export {createBedrockProvider} from './providers/bedrock/index.js';
export type {BedrockConfig} from './providers/bedrock/index.js';
export {createVertexProvider} from './providers/vertex/index.js';
export type {VertexConfig} from './providers/vertex/index.js';
export {createOpenAIProvider} from './providers/openai/index.js';
export type {OpenAIConfig} from './providers/openai/index.js';
export {createAnthropicProvider} from './providers/anthropic/index.js';
export type {AnthropicConfig} from './providers/anthropic/index.js';
export {createMockProvider} from './providers/mock/index.js';
export type {MockConfig} from './providers/mock/index.js';

export {ToolRegistry, normalizeToolResponse} from './orchestration/tools/index.js';
export type {
  ToolResponse,
  ToolContext,
  ToolExecutor,
  ToolDefinitionSource,
  RegisteredTool,
} from './orchestration/tools/index.js';

export {InMemorySessionStore} from './infrastructure/stores/inMemorySessionStore.js';
export {InMemoryPromptStore} from './infrastructure/stores/inMemoryPromptStore.js';
export {InMemoryUsageStore} from './infrastructure/stores/inMemoryUsageStore.js';
export {ThinkingTagParser} from './infrastructure/parsers/thinkingTagParser.js';
export type {ParsedSegment} from './infrastructure/parsers/thinkingTagParser.js';
export {log} from './shared/logger.js';
export type {Logger} from './shared/logger.js';

export type {
  AIProvider,
  SendMessageParams,
  StructuredOutputParams,
  ResponseSchema,
  UsageMetadata,
  AIProviderResponse,
  MessageChunk,
  ToolDefinition,
  ToolCall,
  TextMessage,
  ToolUseMessage,
  ToolResultMessage,
  ToolCallContent,
  ToolResultContent,
  Message,
} from './types/ai.js';
export {AIError} from './types/ai.js';

export type {
  SessionEntry,
  UserEntry,
  AssistantEntry,
  ThinkingEntry,
  ToolEntry,
  ChatSession,
  AuthenticatedUser,
} from './types/session.js';
export {ErrorCodes} from './types/session.js';

export type {
  IncomingMessage,
  ConnectedMessage,
  EntryUpsertMessage,
  EntryDeltaMessage,
  EntryCommitMessage,
  EntrySkipMessage,
  ErrorMessage,
  PongMessage,
  StreamEndMessage,
  OutgoingMessage,
  UserMessagePayload,
} from './types/messages.js';

export type {WsAuthenticator, HttpAuthMiddleware, AuthenticatedRequest} from './types/auth.js';
export type {SessionStore, SessionCreateOptions, BaseSession} from './types/sessionStore.js';
export type {PromptStore, PromptTemplate} from './types/promptStore.js';
export type {UsageStore, UsageRecord} from './types/usageStore.js';
