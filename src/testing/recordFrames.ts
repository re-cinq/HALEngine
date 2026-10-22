import {createChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import {ToolRegistry} from '../orchestration/tools/registry.js';
import type {ToolResponse} from '../orchestration/tools/registry.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import {createConnectionHandler} from '../transport/ws/connectionHandler.js';
import type {ConnectionHandlerDeps, ExtWebSocket} from '../transport/ws/connectionHandler.js';
import {createMessageHandler} from '../transport/ws/messageHandler.js';
import {recordingSocket} from '../transport/ws/recordingSocketTestSupport.js';
import {AIError} from '../types/ai.js';
import type {AIProvider, MessageChunk} from '../types/ai.js';
import type {OutgoingMessage} from '../types/messages.js';
import type {ChatSession} from '../types/session.js';
import type {SessionStore} from '../types/sessionStore.js';

// The only strings a recording carries, so two implementers publish byte-identical frames and none of them is real data.
export const USER_MESSAGE = 'What is the weather in Berlin?';
export const TOOL_ARGUMENT = 'Berlin';
export const ASSISTANT_TEXT = '18 degrees and clear';
/** What the rateLimited stub's vendor error names; the published frames are the evidence it never reaches a socket. */
export const INTERNAL_DETAIL = 'quota exceeded for internal account acct-4711';

export type ScenarioName =
  'connectionOpened' | 'simpleAnswer' | 'thinkingThenTool' | 'multiRoundSuppressed' | 'rateLimited';

const text = (value: string): MessageChunk => ({type: 'text', text: value});
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const TOOL_STOP: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
const WEATHER_CALL: MessageChunk = {
  type: 'tool_use',
  toolCall: {id: 'weather-1', name: 'weather', input: {city: TOOL_ARGUMENT}},
};

/** Records the five scenarios `recordedFrames` publishes, normalised, from scripted chunks through the real handlers. */
export async function recordFrames(): Promise<Record<ScenarioName, OutgoingMessage[]>> {
  const suppressing = async (): Promise<ToolResponse> => ({
    result: ASSISTANT_TEXT,
    clientMessages: [
      {
        type: 'entry_upsert',
        index: 0,
        entry: {role: 'assistant', content: ASSISTANT_TEXT, timestamp: new Date().toISOString(), isStreaming: false},
      },
    ],
    suppressAssistantResponse: true,
  });
  return {
    connectionOpened: normalised(await connectionOpened()),
    simpleAnswer: normalised(await turn({provider: scripted([[text(ASSISTANT_TEXT), STOP]])})),
    thinkingThenTool: normalised(
      await turn({
        provider: scripted([
          [text(`<thinking>${TOOL_ARGUMENT}</thinking>`), WEATHER_CALL, TOOL_STOP],
          [text(ASSISTANT_TEXT), STOP],
        ]),
      })
    ),
    multiRoundSuppressed: normalised(
      await turn({
        provider: scripted([
          [text(ASSISTANT_TEXT), WEATHER_CALL, TOOL_STOP],
          [text(ASSISTANT_TEXT), STOP],
        ]),
        tool: suppressing,
      })
    ),
    // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
    rateLimited: normalised(await turn({provider: scripted([], new AIError(INTERNAL_DETAIL, 'RATE_LIMITED', true))})),
  };
}

// Each provider call yields the next literal round, then throws `failWith` if one is given: no vendor, no network.
function scripted(rounds: readonly MessageChunk[][], failWith?: Error): AIProvider {
  let call = 0;
  return {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      yield* rounds[call++] ?? [];
      if (failWith) throw failWith;
    },
    async generateStructured<T>(): Promise<T> {
      throw new Error('the frame recorder records no structured output');
    },
  };
}

interface Scenario {
  provider: AIProvider;
  tool?: () => Promise<ToolResponse>;
}

// One user message through the real orchestrator and message handler; returns every frame the client was sent.
async function turn({provider, tool}: Scenario): Promise<OutgoingMessage[]> {
  const registry = new ToolRegistry();
  const answer = tool ?? (async () => ({result: ASSISTANT_TEXT}));
  registry.register({name: 'weather', description: 'Reports the weather.', inputSchema: {type: 'object'}}, answer);
  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'Frame recorder.'}), registry);
  const socket = recordingSocket();
  const session: ChatSession = {sessionId: 'recorded', userId: 'recorder', entries: []};
  await createMessageHandler(orchestrator)(socket.ws, session, {type: 'user_message', content: USER_MESSAGE});
  return socket.sent;
}

// The connected frame a new connection receives, from the real connection handler over a store that keeps nothing.
async function connectionOpened(): Promise<OutgoingMessage[]> {
  const sessionStore = {
    create: (sessionId: string, userId: string | number): ChatSession => ({sessionId, userId, entries: []}),
    delete: () => true,
  } as unknown as SessionStore;
  const deps = {
    sessionStore,
    handleMessage: async () => undefined,
    basePath: '/hal',
  } as unknown as ConnectionHandlerDeps;
  const socket = recordingSocket({userId: 'recorder', isAlive: true});
  createConnectionHandler(deps, {getExamplePrompts: () => []})(socket.ws as ExtWebSocket);
  // The frame follows an awaited create, so the recording waits a macrotask for it.
  await new Promise(resolve => setImmediate(resolve));
  socket.close();
  return socket.sent;
}

// No clock or id seam exists, so the recorder replaces what changes on every run with a fixed token.
function normalised(frames: OutgoingMessage[]): OutgoingMessage[] {
  return JSON.parse(JSON.stringify(frames), (key: string, value: unknown) => {
    if (key === 'timestamp') return '<ts>';
    if (key === 'sessionId') return '<session-id>';
    return value;
  }) as OutgoingMessage[];
}
