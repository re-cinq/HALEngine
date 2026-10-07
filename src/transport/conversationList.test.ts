import {WebSocket} from 'ws';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {captureLog} from '../shared/logCaptureTestSupport.js';
import {jest} from '@jest/globals';
import {createMessageHandler} from './ws/messageHandler.js';
import {
  announcedId,
  answeringOrchestrator,
  connectClient,
  deferred,
  startEngineWith,
  stopEngines,
} from './wsTestSupport.js';
import type {ChatSession} from '../types/session.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {MessageChunk} from '../types/ai.js';
import {StoreCannotList} from '../types/sessionStore.js';
import type {SessionListOptions, SessionStore, SessionSummary} from '../types/sessionStore.js';

// The list is answered for the socket's own authenticated user, off the turn lock, and never as a silent empty page.

// Dated ahead of any real clock, so each conversation's activity is this file's choice rather than the test's runtime.
const AHEAD = Date.parse('2099-01-01T00:00:00.000Z');

const enabled = {enabled: true};

interface Reply {
  type: string;
  [key: string]: unknown;
}

/** Sends one frame once the socket opens and resolves with the first reply of the type asked for. */
function asks(url: string, frame: unknown, until: string): {client: WebSocket; reply: Promise<Reply>} {
  const client = connectClient(url);
  const reply = new Promise<Reply>(resolve => {
    client.on('message', raw => {
      const parsed = JSON.parse(String(raw)) as Reply;
      if (parsed.type === until) resolve(parsed);
    });
  });
  client.on('open', () => client.send(JSON.stringify(frame)));
  return {client, reply};
}

/** Resolves with every frame seen up to a pong sent for after the answer, so the set is complete rather than timed. */
function asksThenFences(url: string, frame: unknown, until: string): {client: WebSocket; frames: Promise<Reply[]>} {
  const client = connectClient(url);
  const seen: Reply[] = [];
  const frames = new Promise<Reply[]>(resolve => {
    client.on('message', raw => {
      const parsed = JSON.parse(String(raw)) as Reply;
      if (parsed.type === 'pong') {
        resolve(seen);
        return;
      }
      seen.push(parsed);
      // Pinged only once the answer has arrived: a ping is answered synchronously and would overtake a list that awaits.
      if (parsed.type === until) client.send(JSON.stringify({type: 'ping', timestamp: 1}));
    });
  });
  client.on('open', () => client.send(JSON.stringify(frame)));
  return {client, frames};
}

/** A store holding three of the user's conversations, each with activity of its own, newest last. */
function storeOfThree(): InMemorySessionStore {
  const store = new InMemorySessionStore();
  ['oldest', 'middle', 'newest'].forEach((id, index) => {
    const session = store.create(id, 'u1') as ChatSession;
    session.entries.push({
      role: 'user',
      content: 'hello',
      timestamp: new Date(AHEAD + index * 1000).toISOString(),
    });
  });
  return store;
}

/** Delegates every member the engine uses to a real store, with `listFor` whatever a test needs it to be. */
function storeListing(backing: InMemorySessionStore, listFor?: SessionStore['listFor']): SessionStore {
  return {
    create: (sessionId, userId, options) => backing.create(sessionId, userId, options),
    get: sessionId => backing.get(sessionId),
    delete: sessionId => backing.delete(sessionId),
    count: () => backing.count(),
    clear: () => backing.clear(),
    evict: sessionId => backing.evict(sessionId),
    listFor,
  };
}

const listOnly = (reply: Reply): string[] => (reply.conversations as SessionSummary[]).map(row => row.sessionId);

describe('the conversation list frame', () => {
  const {errors, warnings} = captureLog();

  afterEach(() => stopEngines());

  it("answers the user's conversations newest first, with both times as ISO strings", async () => {
    const {url} = await startEngineWith({sessionStore: storeOfThree(), history: enabled});
    const {client, frames} = asksThenFences(url, {type: 'list_conversations'}, 'conversation_list');
    const idOf = announcedId(client);

    const seen = await frames;
    const lists = seen.filter(seenFrame => seenFrame.type === 'conversation_list');
    const rows = (lists[0]?.conversations ?? []) as SessionSummary[];

    expect({
      // Every frame the answer consisted of: exactly one list, and nothing that belongs to a turn.
      types: seen.map(seenFrame => seenFrame.type),
      order: rows.map(row => row.sessionId),
      newest: rows[0],
    }).toEqual({
      types: ['connected', 'conversation_list'],
      order: ['newest', 'middle', 'oldest', idOf()],
      newest: {
        sessionId: 'newest',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown as string,
        updatedAt: new Date(AHEAD + 2000).toISOString(),
        entryCount: 1,
      },
    });
  });

  it("answers the connecting user's own conversations even when the frame names another user", async () => {
    const asked: Array<string | number> = [];
    const store = recordingStore(asked);
    const {url} = await startEngineWith({sessionStore: store, history: enabled});

    const {reply} = asks(url, {type: 'list_conversations', userId: 'someone-else'}, 'conversation_list');
    await reply;

    expect(asked).toEqual(['u1']);
  });

  it('carries a limit and a cursor through to the store as the frame sent them', async () => {
    const options: Array<SessionListOptions | undefined> = [];
    const store = recordingStore([], options);
    const {url} = await startEngineWith({sessionStore: store, history: enabled});
    const before = {updatedAt: new Date(AHEAD).toISOString(), sessionId: 'newest'};

    const {reply} = asks(url, {type: 'list_conversations', limit: 7, before}, 'conversation_list');
    await reply;

    expect(options).toEqual([{limit: 7, before}]);
  });

  it('puts a time on the wire as an ISO string whatever shape the store answered with', async () => {
    const roundTripped = [
      {
        sessionId: 's1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
        entryCount: 2,
      },
    ] as unknown as SessionSummary[];
    const store = storeListing(new InMemorySessionStore(), () => roundTripped);
    const {url} = await startEngineWith({sessionStore: store, history: enabled});

    const {reply} = asks(url, {type: 'list_conversations'}, 'conversation_list');

    expect((await reply).conversations).toEqual([
      {
        sessionId: 's1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        entryCount: 2,
      },
    ]);
  });

  it('warns at startup when history is on without resume, since no row could then be opened', async () => {
    await startEngineWith({sessionStore: storeOfThree(), history: enabled});

    expect(warnings.filter(line => line.category === 'server')).toEqual([
      {
        category: 'server',
        message: 'conversation history is on but resume is off, so a listed conversation cannot be rejoined',
      },
    ]);
  });

  it('refuses the frame when conversation history is not turned on', async () => {
    const {url} = await startEngineWith({sessionStore: storeOfThree()});

    const {reply} = asks(url, {type: 'list_conversations'}, 'error');

    expect(await reply).toEqual({
      type: 'error',
      code: 'UNSUPPORTED',
      message: 'Conversation history is not enabled on this server',
    });
  });

  it('refuses the frame with resume on but history off, since one switch is not the other', async () => {
    const {url} = await startEngineWith({
      sessionStore: storeOfThree(),
      resume: {enabled: true, latest: true},
    });

    const {reply} = asks(url, {type: 'list_conversations'}, 'error');

    expect((await reply).code).toBe('UNSUPPORTED');
  });

  it('lists the conversation the connection is in, like any other, holding no entries yet', async () => {
    const store = new InMemorySessionStore();
    store.create('earlier', 'u1');
    const {url} = await startEngineWith({sessionStore: store, history: enabled});

    const {client, reply} = asks(url, {type: 'list_conversations'}, 'conversation_list');
    const idOf = announcedId(client);
    const rows = (await reply).conversations as SessionSummary[];

    // Sorted, not in answered order: both were created in the same millisecond, so the id breaks the tie between them.
    expect(
      rows.map(row => `${row.sessionId === idOf() ? 'this connection' : row.sessionId}:${row.entryCount}`).sort()
    ).toEqual(['earlier:0', 'this connection:0']);
  });

  it('answers a handler built with no store at all, rather than leaving the client waiting', async () => {
    const ws = {send: jest.fn(), readyState: WebSocket.OPEN} as unknown as WebSocket;
    const session = {sessionId: 's1', userId: 'u1', entries: []};

    await createMessageHandler(answeringOrchestrator)(ws, session, {type: 'list_conversations'});

    const sent = (ws.send as jest.Mock).mock.calls;

    expect(sent.map(([frame]) => JSON.parse(String(frame)))).toEqual([
      {type: 'error', code: 'UNSUPPORTED', message: 'Conversation history is not enabled on this server'},
    ]);
  });

  it('refuses the frame when the store cannot list, rather than reporting no conversations', async () => {
    const {url} = await startEngineWith({sessionStore: storeListing(storeOfThree()), history: enabled});

    const {reply} = asks(url, {type: 'list_conversations'}, 'error');

    expect(await reply).toEqual({
      type: 'error',
      code: 'UNSUPPORTED',
      message: 'This session store cannot list conversations',
    });
  });

  it('tells a store that cannot list apart from one that failed, so a misconfiguration is not a blip', async () => {
    const cannot = storeListing(storeOfThree(), () => {
      throw new StoreCannotList('the collection implements no find');
    });
    const {url} = await startEngineWith({sessionStore: cannot, history: enabled});

    const {reply} = asks(url, {type: 'list_conversations'}, 'error');
    const answered = await reply;

    expect({answered, logged: errors}).toEqual({
      answered: {type: 'error', code: 'UNSUPPORTED', message: 'This session store cannot list conversations'},
      logged: [
        {
          category: 'message',
          message: 'store cannot list conversations',
          sessionId: expect.any(String),
          userId: 'u1',
          errorType: 'StoreCannotList',
        },
      ],
    });
  });

  it('answers a failing store with a server error, keeps the socket open, and logs no word the store said', async () => {
    const failing = storeListing(storeOfThree(), () =>
      Promise.reject(new Error('mongodb://admin:hunter2@db:27017 refused'))
    );
    const {url} = await startEngineWith({sessionStore: failing, history: enabled});

    const {client, reply} = asks(url, {type: 'list_conversations'}, 'error');
    const answered = await reply;

    expect({
      answered,
      open: client.readyState === WebSocket.OPEN,
      logged: errors.filter(line => line.message === 'conversation list failed'),
      leaked: JSON.stringify(errors).includes('hunter2'),
    }).toEqual({
      answered: {type: 'error', code: 'SERVER_ERROR', message: 'Could not list conversations'},
      open: true,
      logged: [
        {
          category: 'message',
          message: 'conversation list failed',
          sessionId: expect.any(String),
          userId: 'u1',
          errorType: 'Error',
        },
      ],
      leaked: false,
    });
  });

  it('reports the type of a rejection that is not an Error, rather than failing to describe it', async () => {
    const throwing = storeListing(storeOfThree(), () => Promise.reject('the driver threw a string'));
    const {url} = await startEngineWith({sessionStore: throwing, history: enabled});

    const {reply} = asks(url, {type: 'list_conversations'}, 'error');
    const answered = await reply;

    expect({
      code: answered.code,
      logged: errors.map(line => `${String(line.sessionId).length > 0}:${String(line.errorType)}`),
    }).toEqual({
      code: 'SERVER_ERROR',
      logged: ['true:string'],
    });
  });

  it('reports a send that threw and still answers the next list, rather than wedging the socket', async () => {
    const sends: string[] = [];
    // Twice: the first throw is reported with a second send, and that failing too is what escapes the answer itself.
    let failures = 2;
    const ws = {
      readyState: WebSocket.OPEN,
      send: (frame: string) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('socket went away mid-answer');
        }
        sends.push(frame);
      },
    } as unknown as WebSocket;
    const session = {sessionId: 's1', userId: 'u1', entries: []};
    const handle = createMessageHandler(answeringOrchestrator, {
      sessionStore: new InMemorySessionStore(),
      history: enabled,
    });

    await handle(ws, session, {type: 'list_conversations'}).catch(() => undefined);
    await handle(ws, session, {type: 'list_conversations'});

    expect(sends.map(frame => (JSON.parse(frame) as Reply).type)).toEqual(['error', 'conversation_list']);
  });

  it('reads the store once at a time per socket, however many frames arrive in one tick', async () => {
    const seen = {inFlight: 0, peak: 0, answered: 0};
    const counting = storeListing(new InMemorySessionStore(), async (): Promise<SessionSummary[]> => {
      seen.inFlight += 1;
      seen.peak = Math.max(seen.peak, seen.inFlight);
      await Promise.resolve();
      seen.inFlight -= 1;
      return [];
    });
    const {url} = await startEngineWith({sessionStore: counting, history: enabled});

    const client = connectClient(url);
    const allAnswered = new Promise<void>(resolve => {
      client.on('message', raw => {
        if ((JSON.parse(String(raw)) as Reply).type !== 'conversation_list') return;
        seen.answered += 1;
        if (seen.answered === 10) resolve();
      });
    });
    client.on('open', () => {
      for (let sent = 0; sent < 10; sent++) client.send(JSON.stringify({type: 'list_conversations'}));
    });
    await allAnswered;

    expect({peak: seen.peak, answered: seen.answered}).toEqual({peak: 1, answered: 10});
  });

  it('answers a list in the middle of a streaming turn, before that turn ends', async () => {
    const held = deferred();
    const blocking: ChatOrchestrator = {
      processMessage: async () => 'hi',
      async *processMessageStream(): AsyncGenerator<MessageChunk> {
        yield {type: 'text', text: 'first'};
        await held.until;
        yield {type: 'text', text: 'second'};
        yield {type: 'stop', stopReason: 'end_turn'};
      },
    };
    const {url} = await startEngineWith({
      sessionStore: storeOfThree(),
      history: enabled,
      orchestrator: blocking,
    });

    const client = connectClient(url);
    const order: string[] = [];
    const ended = new Promise<void>(resolve => {
      client.on('message', raw => {
        const {type} = JSON.parse(String(raw)) as Reply;
        order.push(type);
        // Released only once the list has been answered, so the turn cannot end before the list arrives by luck.
        if (type === 'conversation_list') held.release();
        if (type === 'stream_end') resolve();
      });
    });

    client.on('open', () => {
      client.send(JSON.stringify({type: 'user_message', content: 'hello'}));
      client.send(JSON.stringify({type: 'list_conversations'}));
    });
    await ended;

    // The whole order, not positions: a list that never arrived would read as -1 and sit before everything.
    expect(order).toEqual([
      'connected',
      'entry_upsert',
      'conversation_list',
      'entry_upsert',
      'entry_delta',
      'entry_delta',
      'entry_commit',
      'stream_end',
    ]);
  });

  it('hands a client an id it can rejoin the conversation with', async () => {
    const store = storeOfThree();
    const {url} = await startEngineWith({sessionStore: store, history: enabled, resume: {enabled: true}});
    const {reply} = asks(url, {type: 'list_conversations'}, 'conversation_list');
    const listed = listOnly(await reply);

    const rejoin = connectClient(`${url}?sessionId=${listed[0]}`);
    const connected = await new Promise<Reply>(resolve => {
      rejoin.on('message', raw => {
        const parsed = JSON.parse(String(raw)) as Reply;
        if (parsed.type === 'connected') resolve(parsed);
      });
    });

    expect({id: connected.sessionId, resumed: connected.resumed, entries: connected.entryCount}).toEqual({
      id: 'newest',
      resumed: true,
      entries: 1,
    });
  });
});

function recordingStore(
  asked: Array<string | number>,
  options: Array<SessionListOptions | undefined> = []
): SessionStore {
  return storeListing(new InMemorySessionStore(), (userId, listOptions): SessionSummary[] => {
    asked.push(userId);
    options.push(listOptions);
    return [];
  });
}
