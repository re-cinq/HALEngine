import type {WebSocket} from 'ws';
import {createChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {setLogger} from '../shared/logger.js';
import type {AIProvider} from '../types/ai.js';
import type {WsAuthenticator} from '../types/auth.js';
import type {HalServer} from './createServer.js';
import {announcedId, askOnOpen, deferred, startEngineWith, stopEngines} from './wsTestSupport.js';

interface Interruption {
  close: (client: WebSocket, hal: HalServer) => void;
  wsAuth?: WsAuthenticator;
  token?: string;
}

// One question whose socket `close` shuts once the first word has arrived; resolves after the abandoned run has ended.
async function interruptedTurn({close, wsAuth, token}: Interruption) {
  const {provider, gate, pulled, state} = gatedProvider();
  const hooksSeen = {afterSession: 0, onError: 0};
  const finished = deferred();
  const disconnected = deferred();
  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'Close test.'}), undefined, {
    hooks: {
      afterSession: async () => {
        hooksSeen.afterSession++;
        finished.release();
      },
      onError: async () => void hooksSeen.onError++,
    },
  });
  const sessionStore = new InMemorySessionStore();
  const onDisconnect = () => disconnected.release();
  const {url, hal} = await startEngineWith({sessionStore, orchestrator, onDisconnect, ...(wsAuth ? {wsAuth} : {})});
  const {client, finished: answering} = askOnOpen(url, {until: 'entry_delta', token});
  const sessionId = announcedId(client);
  await answering;
  await closeMidAnswer(() => close(client, hal), {disconnected, gate, finished});

  const session = await sessionStore.get(sessionId());
  return {sessionId: sessionId(), pulled, returned: state.returned, hooksSeen, entries: session?.entries};
}

type Deferred = ReturnType<typeof deferred>;

// The provider may go on only once the server has seen the close, so whatever it does next happens after it.
async function closeMidAnswer(
  close: () => void,
  {disconnected, gate, finished}: {disconnected: Deferred; gate: Deferred; finished: Deferred}
): Promise<void> {
  close();
  await disconnected.until;
  gate.release();
  await finished.until;
  await new Promise(resolve => setImmediate(resolve));
}

// Streams 'Hal', waits at a gate the test opens once the socket has closed, then would stream two more words; it ignores its signal, as a provider may.
function gatedProvider() {
  const gate = deferred();
  const pulled: string[] = [];
  const state = {returned: false};
  const provider: AIProvider = {
    async *sendMessage() {
      try {
        for (const word of ['Hal', 'lo ', 'there']) {
          pulled.push(word);
          yield {type: 'text', text: word};
          if (word === 'Hal') await gate.until;
        }
        yield {type: 'stop', stopReason: 'end_turn'};
      } finally {
        state.returned = true;
      }
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
  return {provider, gate, pulled, state};
}

describe('a socket that closes mid-answer', () => {
  afterEach(async () => {
    await stopEngines();
  });

  it('stops the run pulling chunks, fires afterSession once and onError never, and keeps the answer as it stood', async () => {
    const t = await interruptedTurn({close: client => client.close()});

    expect(t).toMatchObject({
      pulled: ['Hal', 'lo '],
      returned: true,
      hooksSeen: {afterSession: 1, onError: 0},
      entries: [
        {role: 'user', content: 'hello'},
        {role: 'assistant', content: 'Hal', isStreaming: false, truncated: true},
      ],
    });
  });

  it('logs the abandonment as its session id and elapsed time alone, and no user id or credential from the close on', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const keep = (level: string) => (category: string, message: string, fields?: Record<string, unknown>) =>
      void lines.push({level, category, message, ...fields});
    setLogger({debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error')});
    let fromClose = 0;

    try {
      const t = await interruptedTurn({
        close: client => {
          fromClose = lines.length;
          client.close();
        },
        wsAuth: (async () => ({id: 'user-4b1d'})) as unknown as WsAuthenticator,
        token: 'token-7f3a',
      });
      const afterClose = lines.slice(fromClose);

      expect({
        abandoned: afterClose.filter(line => line.message === 'turn abandoned: its socket closed'),
        leaked: ['user-4b1d', 'token-7f3a'].filter(value =>
          afterClose.some(line => JSON.stringify(line).includes(value))
        ),
      }).toEqual({
        abandoned: [
          {
            level: 'info',
            category: 'message',
            message: 'turn abandoned: its socket closed',
            sessionId: t.sessionId,
            elapsedMs: expect.any(Number),
          },
        ],
        leaked: [],
      });
    } finally {
      setLogger();
    }
  });

  it('abandons a turn in flight when the server stops, as a deploy does', async () => {
    const t = await interruptedTurn({close: (_client, hal) => void hal.stop()});

    expect(t).toMatchObject({pulled: ['Hal', 'lo '], returned: true, hooksSeen: {afterSession: 1, onError: 0}});
  });
});
