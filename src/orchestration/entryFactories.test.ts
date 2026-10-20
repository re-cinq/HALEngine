import {createThinkingEntry} from './entryFactories.js';
import {createChatOrchestrator} from './chatOrchestrator.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import type {AIProvider, MessageChunk} from '../types/ai.js';
import type {ChatSession, SessionEntry, ThinkingEntry} from '../types/session.js';

describe('entry and session timestamps', () => {
  it('stamps a thinking entry with an ISO 8601 timestamp that round-trips through Date', () => {
    const entry = createThinkingEntry() as ThinkingEntry;

    expect(new Date(entry.timestamp ?? '').toISOString()).toBe(entry.timestamp);
  });

  it('reads timestamp off any SessionEntry with no role narrowing, and accepts a thinking entry without one', () => {
    const stored: ThinkingEntry = {role: 'thinking', content: 'stored before 0.9', isStreaming: false};
    const entries: SessionEntry[] = [stored, createThinkingEntry()];

    const stamps: Array<string | undefined> = entries.map(entry => entry.timestamp);

    expect(stamps.map(stamp => typeof stamp)).toEqual(['undefined', 'string']);
  });

  it('completes a turn unchanged on a session with no createdAt, as one stored before the field existed would be', async () => {
    const provider: AIProvider = {
      async *sendMessage(): AsyncGenerator<MessageChunk> {
        yield {type: 'text', text: 'hello back'};
        yield {type: 'stop', stopReason: 'end_turn'};
      },
      generateStructured: async <T>() => ({}) as T,
    };
    const session: ChatSession = {
      sessionId: 's',
      userId: 'u',
      entries: [{role: 'user', content: 'hi', timestamp: 't'}],
    };

    const reply = await createChatOrchestrator(provider, new PromptBuilder({identity: 'Timestamps.'})).processMessage(
      session
    );

    expect({reply, createdAt: 'createdAt' in session}).toEqual({reply: 'hello back', createdAt: false});
  });
});
