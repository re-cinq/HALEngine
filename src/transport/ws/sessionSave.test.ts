import type {WebSocket} from 'ws';
import {createMessageHandler} from './messageHandler.js';
import {createChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import {
  answering,
  failingMidStream,
  recordingSessionStore,
  writeSignalPromptBuilder,
} from '../../infrastructure/writeSignalTestSupport.js';
import type {ChatSession, SessionEntry} from '../../types/session.js';
import type {OutgoingMessage} from '../../types/messages.js';

// The transport commits the assistant entry, so only a turn driven through it can prove what save receives.

// Timestamps are generated; no assertion should read one.
const shape = (entry: SessionEntry): Record<string, unknown> =>
  entry.role === 'assistant'
    ? {role: entry.role, content: entry.content, isStreaming: entry.isStreaming}
    : {role: entry.role, content: 'content' in entry ? entry.content : ''};

const turn = async (onSave: (session: ChatSession) => void, provider = answering('hello back')) => {
  const sent: OutgoingMessage[] = [];
  const ws = {send: (raw: string) => sent.push(JSON.parse(raw) as OutgoingMessage)} as unknown as WebSocket;
  const sessionStore = recordingSessionStore(onSave);
  const orchestrator = createChatOrchestrator(provider, writeSignalPromptBuilder, undefined, {sessionStore});
  const session = sessionStore.create('s1', 'u1') as ChatSession;

  await createMessageHandler(orchestrator)(ws, session, {type: 'user_message', content: 'hello'});

  return sent.map(frame => frame.type);
};

describe('what the session write signal carries', () => {
  it('saves the user entry and the committed assistant entry', async () => {
    const saved: Array<Record<string, unknown>[]> = [];

    await turn(session => void saved.push(session.entries.map(shape)));

    expect(saved).toEqual([
      [
        {role: 'user', content: 'hello'},
        {role: 'assistant', content: 'hello back', isStreaming: false},
      ],
    ]);
  });

  it('saves a committed assistant entry even when the provider dies mid-stream', async () => {
    const saved: Array<Record<string, unknown>[]> = [];

    await turn(session => void saved.push(session.entries.map(shape)), failingMidStream('provider died'));

    expect(saved).toEqual([
      [
        {role: 'user', content: 'hello'},
        {role: 'assistant', content: 'partial answer', isStreaming: false},
      ],
    ]);
  });
});
