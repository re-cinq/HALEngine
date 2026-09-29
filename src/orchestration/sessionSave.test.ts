import {createChatOrchestrator} from './chatOrchestrator.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {
  answering,
  failing,
  recordingSessionStore,
  writeSignalPromptBuilder,
} from '../infrastructure/writeSignalTestSupport.js';
import {setLogger} from '../shared/logger.js';
import type {AIProvider} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';
import type {SessionStore} from '../types/sessionStore.js';

const SENT_AT = '2026-01-01T00:00:00.000Z';

const sessionWith = (content: string): ChatSession => ({
  sessionId: 's1',
  userId: 'u1',
  entries: [{role: 'user', content, timestamp: SENT_AT}],
});

describe('the session write signal', () => {
  const errors: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    errors.length = 0;
    const quiet = () => undefined;
    setLogger({
      debug: quiet,
      info: quiet,
      warn: quiet,
      error: (category, message, fields) => void errors.push({category, message, ...fields}),
    });
  });

  afterEach(() => setLogger());

  // One outcome value per turn, so each test below can assert with a single expect.
  const turn = async (sessionStore: SessionStore, provider: AIProvider = answering('hi')): Promise<string> => {
    const orchestrator = createChatOrchestrator(provider, writeSignalPromptBuilder, undefined, {sessionStore});
    return orchestrator.processMessage(sessionWith('hello')).catch((error: Error) => `threw: ${error.message}`);
  };

  it('saves once for one processed user message', async () => {
    const saved: string[] = [];

    await turn(recordingSessionStore(session => void saved.push(session.sessionId)));

    expect(saved).toEqual(['s1']);
  });

  it('saves once and still rethrows when the provider fails', async () => {
    const saved: string[] = [];
    const store = recordingSessionStore(session => void saved.push(session.sessionId));

    const outcome = await turn(store, failing('provider gone'));

    expect({outcome, saved}).toEqual({outcome: 'threw: provider gone', saved: ['s1']});
  });

  it('keeps the turn alive and logs once when save rejects', async () => {
    const outcome = await turn(recordingSessionStore(() => Promise.reject(new Error('mongo down'))));

    expect({outcome, errors}).toEqual({
      outcome: 'hi',
      errors: [{category: 'orchestrator', message: 'session save failed', sessionId: 's1', error: 'mongo down'}],
    });
  });

  it('keeps the turn alive when save throws synchronously', async () => {
    const outcome = await turn(
      recordingSessionStore(() => {
        throw new Error('forgot to be async');
      })
    );

    expect({outcome, logged: errors.length}).toEqual({outcome: 'hi', logged: 1});
  });

  it('logs nothing for a store that implements no save', async () => {
    const outcome = await turn(new InMemorySessionStore());

    expect({outcome, logged: errors.length}).toEqual({outcome: 'hi', logged: 0});
  });
});
