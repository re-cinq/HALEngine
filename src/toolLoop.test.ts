import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import {CALL_A, CALL_B, twoTools} from './orchestration/toolLoopTestSupport.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import {createMockProvider} from './providers/mock/mockProvider.js';
import type {MockTurn} from './providers/mock/mockProvider.js';
import {collectChunks} from './providers/providerTestSupport.js';
import type {Message, SendMessageParams, ToolCallContent} from './types/ai.js';
import type {ChatSession, SessionEntry} from './types/session.js';

// specs/hal-engine-architecture § Tool Execution Loop: the cases the package's own scripted mock can drive.

const SENT_AT = '2026-01-01T00:00:00.000Z';
const promptBuilder = new PromptBuilder({identity: 'You are a test assistant.'});

const askSession = (): ChatSession => ({
  sessionId: 's1',
  userId: 'u1',
  entries: [{role: 'user', content: 'ask', timestamp: SENT_AT}],
});
const upserted = (content: string): SessionEntry => ({
  role: 'assistant',
  content,
  timestamp: SENT_AT,
  isStreaming: false,
});

const toolUseIdsOf = (message: Message): string[][] => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const toolUses = message.content.filter((block): block is ToolCallContent => block.type === 'tool_use');
  return [toolUses.map(block => block.toolUseId)];
};

const assistantToolUseIds = (messages: Message[]): string[][] => messages.flatMap(toolUseIdsOf);

// The package's scripted mock, keeping every request it was sent.
const recordingMock = (turns: MockTurn[]) => {
  const sent: SendMessageParams[] = [];
  const provider = createMockProvider({type: 'mock', turns, onSendMessage: params => void sent.push(params)});
  return {provider, sent};
};

describe('ChatOrchestrator tool loop, a round with more than one call', () => {
  it('runs both executors of a two-call round and sends the next round one assistant message with two tool_use items and one user message with two tool_result items whose ids match, in script order', async () => {
    const {provider, sent} = recordingMock([{toolCalls: [CALL_A, CALL_B]}, {text: 'done'}]);
    const {registry, ran} = twoTools({first: {result: 'one'}, second: {result: 'two'}});

    await collectChunks(createChatOrchestrator(provider, promptBuilder, registry).processMessageStream(askSession()));
    const {messages} = sent[1];
    const [assistant, user] = messages.slice(-2);

    expect({calls: sent.length, ran, assistant, user}).toEqual({
      calls: 2,
      ran: ['first', 'second'],
      assistant: {
        role: 'assistant',
        content: [
          {type: 'tool_use', toolUseId: 'call-a', name: 'first', input: {a: 1}},
          {type: 'tool_use', toolUseId: 'call-b', name: 'second', input: {b: 2}},
        ],
      },
      user: {
        role: 'user',
        content: [
          {type: 'tool_result', toolUseId: 'call-a', content: 'one'},
          {type: 'tool_result', toolUseId: 'call-b', content: 'two'},
        ],
      },
    });
  });

  it('yields exactly one suppress_output chunk, after the tool_result chunk, when one of two executors suppresses', async () => {
    const provider = createMockProvider({type: 'mock', turns: [{toolCalls: [CALL_A, CALL_B]}, {text: 'done'}]});
    const {registry} = twoTools({
      first: {result: 'one', clientMessages: [{type: 'entry_commit', index: 0}]},
      second: {result: 'two', suppressAssistantResponse: true},
    });

    const chunks = await collectChunks(
      createChatOrchestrator(provider, promptBuilder, registry).processMessageStream(askSession())
    );

    expect(chunks.map(c => c.type)).toEqual([
      'tool_use',
      'tool_use',
      'stop',
      'tool_result',
      'suppress_output',
      'text',
      'stop',
    ]);
  });

  it('gives two upserted entries sequential indices from the session length at call time, and both are readable from the session afterwards', async () => {
    const [one, two] = [upserted('first card'), upserted('second card')];
    const provider = createMockProvider({type: 'mock', turns: [{toolCalls: [CALL_A, CALL_B]}, {text: 'done'}]});
    const {registry} = twoTools({
      first: {
        result: 'one',
        clientMessages: [
          {type: 'entry_upsert', index: 999, entry: one},
          {type: 'entry_upsert', index: 999, entry: two},
        ],
      },
      second: {result: 'two'},
    });
    const session = askSession();
    const lengthAtCall = session.entries.length;

    const chunks = await collectChunks(
      createChatOrchestrator(provider, promptBuilder, registry).processMessageStream(session)
    );

    expect({
      toolResult: chunks.find(c => c.type === 'tool_result'),
      appended: session.entries.slice(lengthAtCall),
    }).toEqual({
      toolResult: {
        type: 'tool_result',
        clientMessages: [
          {type: 'entry_upsert', index: lengthAtCall, entry: one},
          {type: 'entry_upsert', index: lengthAtCall + 1, entry: two},
        ],
      },
      appended: [one, two],
    });
  });

  it('yields no tool_result chunk for a round whose executors return no client messages', async () => {
    const provider = createMockProvider({type: 'mock', turns: [{toolCalls: [CALL_A]}, {text: 'done'}]});
    const {registry} = twoTools({first: {result: 'one'}, second: {result: 'two'}});

    const chunks = await collectChunks(
      createChatOrchestrator(provider, promptBuilder, registry).processMessageStream(askSession())
    );

    expect(chunks.map(c => c.type)).toEqual(['tool_use', 'stop', 'text', 'stop']);
  });

  it('carries no pending call from one round into the next: three rounds leave two assistant messages with one tool_use item each, and each executor ran once', async () => {
    const {provider, sent} = recordingMock([{toolCalls: [CALL_A]}, {toolCalls: [CALL_B]}, {text: 'done'}]);
    const {registry, ran} = twoTools({first: {result: 'one'}, second: {result: 'two'}});

    await collectChunks(createChatOrchestrator(provider, promptBuilder, registry).processMessageStream(askSession()));

    expect({calls: sent.length, ran, toolUseIds: assistantToolUseIds(sent[2].messages)}).toEqual({
      calls: 3,
      ran: ['first', 'second'],
      toolUseIds: [['call-a'], ['call-b']],
    });
  });

  it('ends a scripted tool_use turn after one round with no registry: one provider call, the tool_use and stop chunks alone', async () => {
    const {provider, sent} = recordingMock([{toolCalls: [CALL_A]}, {text: 'never'}]);

    const chunks = await collectChunks(
      createChatOrchestrator(provider, promptBuilder).processMessageStream(askSession())
    );

    expect({calls: sent.length, types: chunks.map(c => c.type)}).toEqual({calls: 1, types: ['tool_use', 'stop']});
  });
});
