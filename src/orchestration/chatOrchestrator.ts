import type {ChatSession} from '../types/session.js';
import type {ToolRegistry, ToolContext} from './tools/registry.js';
import type {
  AIProvider,
  Message,
  MessageChunk,
  SendMessageParams,
  ToolCall,
  ToolResultContent,
  UsageMetadata,
} from '../types/ai.js';
import type {OutgoingMessage} from '../types/messages.js';
import type {PromptBuilder, PromptBuilderOptions} from '../infrastructure/builders/promptBuilder.js';
import {toMessages, createContextConfig} from './conversationContext.js';
import type {ContextConfig} from './conversationContext.js';
import {
  shouldContinueToolLoop,
  collectText,
  buildToolCallMessages,
  collectToolCalls,
  extractStopReason,
  extractUsage,
} from './orchestratorHelpers.js';
import {appendEntry} from './entryMutations.js';
import {log} from '../shared/logger.js';

const DEFAULT_MAX_TOOL_ROUNDS = 5;

export interface OrchestratorHooks {
  beforeSession?: (session: ChatSession) => Promise<void>;
  afterSession?: (session: ChatSession) => Promise<void>;
  beforeUserInput?: (session: ChatSession, userMessage: string) => Promise<string>;
  afterUserInput?: (session: ChatSession, userMessage: string) => Promise<void>;
  beforeModelResponse?: (session: ChatSession, systemPrompt: string) => Promise<string>;
  afterModelResponse?: (session: ChatSession, responseText: string, usage?: UsageMetadata) => Promise<void>;
  onError?: (session: ChatSession, error: Error) => Promise<void>;
}

export interface ChatOrchestrator {
  processMessage(session: ChatSession): Promise<string>;
  processMessageStream(session: ChatSession): AsyncGenerator<MessageChunk>;
}

export interface ChatOrchestratorOptions {
  maxToolRounds?: number;
  contextConfig?: Partial<ContextConfig>;
  promptBuilderOptions?: PromptBuilderOptions;
  hooks?: OrchestratorHooks;
}

interface ToolExecutionResult {
  clientMessages: OutgoingMessage[];
  suppressOutput: boolean;
}
export function createChatOrchestrator(
  provider: AIProvider,
  promptBuilder: PromptBuilder,
  toolRegistry?: ToolRegistry,
  options?: ChatOrchestratorOptions
): ChatOrchestrator {
  const maxToolRounds = options?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const contextConfig = createContextConfig(options?.contextConfig);
  const toolInstructions = toolRegistry?.getPromptInstructions();
  const baseSystemPrompt = promptBuilder.build({...options?.promptBuilderOptions, toolInstructions});
  const tools = toolRegistry?.getDefinitions();
  const hooks = options?.hooks;

  return {
    async processMessage(session: ChatSession): Promise<string> {
      return collectText(this.processMessageStream(session));
    },

    async *processMessageStream(session: ChatSession): AsyncGenerator<MessageChunk> {
      try {
        if (hooks?.beforeSession) await hooks.beforeSession(session);

        let userMessage = lastUserContent(session);

        if (hooks?.beforeUserInput) {
          userMessage = await rewriteUserMessage(session, userMessage, hooks.beforeUserInput);
        }

        if (hooks?.afterUserInput) await hooks.afterUserInput(session, userMessage);

        const systemPrompt = hooks?.beforeModelResponse
          ? await hooks.beforeModelResponse(session, baseSystemPrompt)
          : baseSystemPrompt;

        const messages: Message[] = toMessages(session.entries, contextConfig);
        let lastUsage: UsageMetadata | undefined;
        let responseText = '';

        for (let round = 0; round <= maxToolRounds; round++) {
          log.info('orchestrator', 'starting round', {round});
          const pendingToolCalls: ToolCall[] = [];

          const outcome = yield* streamRound(provider, {messages, systemPrompt, tools}, pendingToolCalls);
          responseText += outcome.text;
          lastUsage = outcome.usage ?? lastUsage;

          if (!shouldContinueToolLoop(outcome.stopReason, pendingToolCalls, toolRegistry)) break;

          log.info('orchestrator', 'executing tools', {tools: pendingToolCalls.map(tc => tc.name)});
          const {clientMessages, suppressOutput} = await executeToolCalls(
            pendingToolCalls,
            messages,
            toolRegistry!,
            session
          );
          log.info('orchestrator', 'tool execution complete', {
            clientMessageCount: clientMessages.length,
            clientMessageTypes: clientMessages.map(m => m.type),
            suppressOutput,
          });

          if (clientMessages.length > 0) {
            yield {type: 'tool_result' as const, clientMessages};
          }

          if (suppressOutput) {
            yield {type: 'suppress_output' as const};
          }
        }

        if (hooks?.afterModelResponse) await hooks.afterModelResponse(session, responseText, lastUsage);
      } catch (error) {
        if (hooks?.onError && error instanceof Error) {
          await hooks.onError(session, error);
        }
        throw error;
      } finally {
        if (hooks?.afterSession) await hooks.afterSession(session);
      }
    },
  };
}

interface RoundOutcome {
  stopReason: string;
  text: string;
  usage?: UsageMetadata;
}

// `yield*` in the caller evaluates to this return, so the round's totals come back as data.
async function* streamRound(
  provider: AIProvider,
  request: SendMessageParams,
  pendingToolCalls: ToolCall[]
): AsyncGenerator<MessageChunk, RoundOutcome> {
  let stopReason = '';
  let text = '';
  let usage: UsageMetadata | undefined;

  for await (const chunk of provider.sendMessage(request)) {
    yield chunk;
    collectToolCalls(chunk, pendingToolCalls);
    stopReason = extractStopReason(chunk) ?? stopReason;
    usage = extractUsage(chunk) ?? usage;
    if (chunk.type === 'text') text += chunk.text;
  }

  return {stopReason, text, usage};
}

// A changed message is also written back to the session's last user entry.
async function rewriteUserMessage(
  session: ChatSession,
  userMessage: string,
  hook: (session: ChatSession, userMessage: string) => Promise<string>
): Promise<string> {
  const modified = await hook(session, userMessage);
  if (modified === userMessage) return userMessage;

  updateLastUserContent(session, modified);
  return modified;
}

function lastUserContent(session: ChatSession): string {
  for (let i = session.entries.length - 1; i >= 0; i--) {
    const entry = session.entries[i];
    if (entry.role === 'user') return entry.content;
  }
  return '';
}

function updateLastUserContent(session: ChatSession, content: string): void {
  for (let i = session.entries.length - 1; i >= 0; i--) {
    const entry = session.entries[i];
    if (entry.role === 'user') {
      entry.content = content;
      return;
    }
  }
}

async function executeToolCalls(
  pendingToolCalls: ToolCall[],
  messages: Message[],
  toolRegistry: ToolRegistry,
  session: ChatSession
): Promise<ToolExecutionResult> {
  messages.push(buildToolCallMessages(pendingToolCalls));

  const context: ToolContext = {
    userId: session.userId,
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    authHeaders: session.authHeaders,
  };

  const responses = await Promise.all(
    pendingToolCalls.map(async tc => {
      const response = await toolRegistry.execute(tc.name, tc.input, context);
      return {tc, response};
    })
  );

  const toolResults: ToolResultContent[] = responses.map(({tc, response}) => ({
    type: 'tool_result' as const,
    toolUseId: tc.id,
    content: response.result,
  }));
  messages.push({role: 'user', content: toolResults});

  const rawClientMessages = responses.flatMap(({response}) => response.clientMessages ?? []);

  return {
    clientMessages: assignEntryIndices(rawClientMessages, session),
    suppressOutput: responses.some(({response}) => response.suppressAssistantResponse === true),
  };
}

function assignEntryIndices(clientMessages: OutgoingMessage[], session: ChatSession): OutgoingMessage[] {
  return clientMessages.map(msg => {
    if (msg.type !== 'entry_upsert') return msg;
    const index = appendEntry(session, msg.entry);
    return {...msg, index};
  });
}
