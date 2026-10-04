import type {ChatSession} from '../types/session.js';
import type {ToolRegistry, ToolContext, ToolResponse} from './tools/registry.js';
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
import type {SessionStore} from '../types/sessionStore.js';
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
import {appendEntry, commitStreamingEntries} from './entryMutations.js';
import {log} from '../shared/logger.js';

const DEFAULT_MAX_TOOL_ROUNDS = 5;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
// Node fires a timer at once when its delay exceeds this, so a longer deadline is held here instead.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const TIMED_OUT = Symbol('timed out');
const ABANDONED = Symbol('abandoned');
type Stop = typeof TIMED_OUT | typeof ABANDONED;

export interface OrchestratorHooks {
  beforeSession?: (session: ChatSession) => Promise<void>;
  afterSession?: (session: ChatSession) => Promise<void>;
  beforeUserInput?: (session: ChatSession, userMessage: string) => Promise<string>;
  afterUserInput?: (session: ChatSession, userMessage: string) => Promise<void>;
  beforeModelResponse?: (session: ChatSession, systemPrompt: string) => Promise<string>;
  afterModelResponse?: (session: ChatSession, responseText: string, totalUsage?: UsageMetadata) => Promise<void>;
  onError?: (session: ChatSession, error: Error) => Promise<void>;
  /** The supported seam for an EU AI Act Art. 14 human-oversight control: fires before each known tool's executor, and a returned ToolResponse replaces the call (see docs/adding-a-tool.md); it receives the model's raw tool input and, through session, the caller's authHeaders, so a policy that logs either logs personal data and credential material; the engine asserts nothing about any policy installed here. */
  beforeToolCall?: (session: ChatSession, call: ToolCall) => Promise<ToolResponse | undefined>;
  /** Fires when the model asks for a tool round the budget refuses, after the last provider call and before afterModelResponse; a returned string reaches the user as the turn's closing text, and the engine writes none of its own (see specs/hal-engine-tool-budget/spec.md). */
  onToolBudgetExhausted?: (session: ChatSession, budget: ToolBudgetInfo) => Promise<string | undefined>;
}

export interface ToolBudgetInfo {
  maxToolRounds: number;
  requestedTools: string[];
}

type BeforeToolCall = NonNullable<OrchestratorHooks['beforeToolCall']>;
type OnToolBudgetExhausted = NonNullable<OrchestratorHooks['onToolBudgetExhausted']>;

export const TOOL_BUDGET_EXHAUSTED = 'tool_budget_exhausted';

export interface ChatOrchestrator {
  processMessage(session: ChatSession): Promise<string>;
  /** Aborting `signal` abandons the run: no further provider or tool call, no error and no `onError` (specs/hal-engine-abandon-on-close/spec.md). */
  processMessageStream(session: ChatSession, options?: {signal?: AbortSignal}): AsyncGenerator<MessageChunk>;
}

export interface ChatOrchestratorOptions {
  maxToolRounds?: number;
  /** How long one tool call may take before it is abandoned and answered with a timeout result; default 30000, and 0 waits forever (specs/hal-engine-tool-budget/spec.md). */
  toolTimeoutMs?: number;
  contextConfig?: Partial<ContextConfig>;
  promptBuilderOptions?: PromptBuilderOptions;
  hooks?: OrchestratorHooks;
  sessionStore?: SessionStore;
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
  const maxToolRounds = normalizeToolRounds(options?.maxToolRounds);
  const toolTimeoutMs = normalizeToolTimeout(options?.toolTimeoutMs);
  const contextConfig = createContextConfig(options?.contextConfig);
  const toolInstructions = toolRegistry?.getPromptInstructions();
  const baseSystemPrompt = promptBuilder.build({...options?.promptBuilderOptions, toolInstructions});
  const tools = toolRegistry?.getDefinitions();
  const hooks = options?.hooks;
  const sessionStore = options?.sessionStore;

  return {
    async processMessage(session: ChatSession): Promise<string> {
      return collectText(this.processMessageStream(session));
    },

    async *processMessageStream(session: ChatSession, options?: {signal?: AbortSignal}): AsyncGenerator<MessageChunk> {
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
        let totalUsage: UsageMetadata | undefined;
        let responseText = '';
        const signal = options?.signal;

        // Bounded by the budget gate below, not the header: maxToolRounds executed rounds, maxToolRounds + 1 provider calls.
        for (let round = 0; ; round++) {
          log.info('orchestrator', 'starting round', {round});
          const pendingToolCalls: ToolCall[] = [];

          const outcome = yield* streamRound(provider, {messages, systemPrompt, tools, signal}, pendingToolCalls);
          // Abandoned mid-round: the provider stopped on the signal, and what it left half-done is not acted on.
          if (signal?.aborted) return;
          responseText += outcome.text;
          totalUsage = accumulateUsage(totalUsage, outcome.usage);

          if (!shouldContinueToolLoop(outcome.stopReason, pendingToolCalls, toolRegistry)) break;
          if (budgetSpent(round, maxToolRounds, pendingToolCalls)) {
            const budget = {maxToolRounds, requestedTools: pendingToolCalls.map(tc => tc.name)};
            responseText += yield* closeExhaustedTurn(session, budget, hooks?.onToolBudgetExhausted);
            break;
          }

          log.info('orchestrator', 'executing tools', {tools: pendingToolCalls.map(tc => tc.name)});
          const {clientMessages, suppressOutput} = await executeToolCalls(
            pendingToolCalls,
            messages,
            session,
            withDeadline(toolCallRunner(toolRegistry!, session, hooks?.beforeToolCall), toolTimeoutMs, signal),
            signal
          );
          // Abandoned while its tools ran: no provider call follows, so nothing they returned is read.
          if (signal?.aborted) return;
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

        if (hooks?.afterModelResponse) await hooks.afterModelResponse(session, responseText, totalUsage);
      } catch (error) {
        // Abandoned by its caller: what the abort caused is no failure, and nobody is left to tell.
        if (options?.signal?.aborted) return;
        if (hooks?.onError) {
          await hooks.onError(
            session,
            error instanceof Error ? error : new Error(describeRejection(error), {cause: error})
          );
        }
        throw error;
      } finally {
        // Before both: a provider that threw mid-stream leaves an entry open, and nothing should persist it that way.
        commitStreamingEntries(session);
        try {
          if (hooks?.afterSession) await hooks.afterSession(session);
        } finally {
          await saveSession(sessionStore, session);
        }
      }
    },
  };
}

// A negative budget means no tool rounds; a non-finite one, NaN included, falls back to the default rather than never ending.
function normalizeToolRounds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TOOL_ROUNDS;
  return Math.max(0, Math.floor(value));
}

// Only 0 opts out of the deadline; a value that is not a usable delay keeps the default rather than silently dropping it.
function normalizeToolTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_TOOL_TIMEOUT_MS;
  return Math.min(value, MAX_TIMER_DELAY_MS);
}

// Gates execution, not the provider call: a round nobody can read is never run, and the call that read the last one already has.
function budgetSpent(round: number, maxToolRounds: number, pendingToolCalls: ToolCall[]): boolean {
  if (round < maxToolRounds) return false;
  log.warn('orchestrator', 'tool budget exhausted', {
    maxToolRounds,
    requestedTools: pendingToolCalls.map(tc => tc.name),
  });
  return true;
}

// The stop always follows the text: the round's own stop already committed its entry, and a bare text chunk would open one never committed.
async function* closeExhaustedTurn(
  session: ChatSession,
  budget: ToolBudgetInfo,
  hook?: OnToolBudgetExhausted
): AsyncGenerator<MessageChunk, string> {
  const sentence = (hook ? await hook(session, budget) : undefined) ?? '';
  if (sentence !== '') yield {type: 'text', text: sentence};
  yield {type: 'stop', stopReason: TOOL_BUDGET_EXHAUSTED};
  return sentence;
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

type ToolCallRun = (tc: ToolCall, signal: AbortSignal) => Promise<ToolResponse>;

// One runner per round: the policy sees each known call before its executor, and an unknown name keeps the registry's own path.
function toolCallRunner(
  toolRegistry: ToolRegistry,
  session: ChatSession,
  beforeToolCall?: BeforeToolCall
): ToolCallRun {
  return async (tc, signal) => {
    const declined =
      beforeToolCall && toolRegistry.has(tc.name) ? await consultPolicy(beforeToolCall, session, tc) : undefined;
    if (declined) return declined;
    // A policy can answer after the deadline, when the model has already been told this call returned nothing.
    if (signal.aborted) return skipAbandoned(tc);
    return toolRegistry.execute(tc.name, tc.input, contextFor(session, signal));
  };
}

// Its result is read by nobody: the round already answered the model at the deadline, so this only keeps the executor from running.
function skipAbandoned(tc: ToolCall): ToolResponse {
  log.info('orchestrator', 'abandoned tool call not started', {tool: tc.name});
  return {result: `The ${tc.name} call was abandoned before it started and was not performed.`};
}

// One per call, so each carries its own signal and a tool that edits a field cannot reach its siblings; authHeaders stays shared.
function contextFor(session: ChatSession, signal: AbortSignal): ToolContext {
  return {
    userId: session.userId,
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    authHeaders: session.authHeaders,
    signal,
  };
}

// The race is the bound, not the signal: few executors read it, so only stopping the wait guarantees the round ends.
function withDeadline(
  run: ToolCallRun,
  toolTimeoutMs: number,
  runSignal: AbortSignal | undefined
): (tc: ToolCall) => Promise<ToolResponse> {
  return async tc => {
    const control = new AbortController();
    // The run's signal reaches the tool composed with the call's own, never in place of its deadline.
    const call = run(tc, runSignal ? AbortSignal.any([runSignal, control.signal]) : control.signal);
    if (toolTimeoutMs === 0 && runSignal === undefined) return call;

    const startedAt = Date.now();
    const stop = stopWhen(toolTimeoutMs, runSignal);
    // Promise.race has subscribed to the call, so a rejection after the stop is handled, and a late result goes nowhere.
    const settled = await Promise.race([call, stop.stopped]).finally(stop.clear);
    // Read by nobody: an abandoned run ends with this round, and no provider call follows it.
    if (settled === ABANDONED) return {result: `The ${tc.name} call was abandoned with its turn.`};
    if (settled !== TIMED_OUT) return settled;

    // A TimeoutError, as AbortSignal.timeout gives, so the registry logs a throw it causes as a failure, unlike an abandoned turn's.
    control.abort(new DOMException(`Tool '${tc.name}' did not answer within ${toolTimeoutMs} ms`, 'TimeoutError'));
    log.warn('orchestrator', 'tool call timed out', {tool: tc.name, elapsedMs: Date.now() - startedAt});
    return {
      result: `Tool '${tc.name}' did not answer within ${toolTimeoutMs} ms, so the call was abandoned and returned no result.`,
    };
  };
}

// Settles at the deadline, never at 0, or once the run is abandoned; clear() drops both, so neither outlives its call.
function stopWhen(ms: number, runSignal: AbortSignal | undefined): {stopped: Promise<Stop>; clear: () => void} {
  const listening = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<Stop>(resolve => {
    if (ms > 0) timer = setTimeout(() => resolve(TIMED_OUT), ms);
    runSignal?.addEventListener('abort', () => resolve(ABANDONED), {once: true, signal: listening.signal});
  });
  const clear = (): void => {
    clearTimeout(timer);
    listening.abort();
  };
  return {stopped, clear};
}

// A throwing policy declines its call rather than failing the turn: every tool_use must still be answered.
async function consultPolicy(
  policy: BeforeToolCall,
  session: ChatSession,
  tc: ToolCall
): Promise<ToolResponse | undefined> {
  try {
    return await policy(session, tc);
  } catch (error) {
    log.warn('orchestrator', 'beforeToolCall threw, so the call is declined', {
      tool: tc.name,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return {result: `The ${tc.name} call was declined and not performed.`};
  }
}

async function executeToolCalls(
  pendingToolCalls: ToolCall[],
  messages: Message[],
  session: ChatSession,
  runToolCall: (tc: ToolCall) => Promise<ToolResponse>,
  signal: AbortSignal | undefined
): Promise<ToolExecutionResult> {
  messages.push(buildToolCallMessages(pendingToolCalls));

  const responses = await Promise.all(
    pendingToolCalls.map(async tc => {
      const response = await runToolCall(tc);
      return {tc, response};
    })
  );
  // Abandoned while they ran: the turn ends here, so nothing they produced is recorded in the session.
  if (signal?.aborted) return {clientMessages: [], suppressOutput: false};

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

// Adds per-round token counts so the hook receives the total across all provider calls in the turn.
function accumulateUsage(acc: UsageMetadata | undefined, next: UsageMetadata | undefined): UsageMetadata | undefined {
  if (!acc) return next;
  if (!next) return acc;
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    totalTokens: acc.totalTokens + next.totalTokens,
  };
}

// A store outage is not a reason to fail the turn the customer already received.
async function saveSession(store: SessionStore | undefined, session: ChatSession): Promise<void> {
  if (!store?.save) return;

  try {
    await store.save(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('orchestrator', 'session save failed', {sessionId: session.sessionId, error: message});
  }
}

function describeRejection(error: unknown): string {
  return serializedOrNull(error) ?? String(error);
}

// A probe, not a fallback path: a circular or BigInt-bearing rejection has no JSON form.
function serializedOrNull(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
