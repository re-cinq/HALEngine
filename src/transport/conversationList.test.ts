import {WebSocket} from 'ws';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {captureErrors} from '../shared/logCaptureTestSupport.js';
import {announcedId, connectClient, startEngineWith, stopEngines} from './wsTestSupport.js';
import type {ChatSession} from '../types/session.js';
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
  const errors = captureErrors();

  afterEach(() => stopEngines());

  it("answers the user's conversations newest first, with both times as ISO strings", async () => {
    const {url} = await startEngineWith({sessionStore: storeOfThree(), history: enabled});
    const {client, reply} = asks(url, {type: 'list_conversations'}, 'conversation_list');
    const idOf = announcedId(client);

    const answered = await reply;
    const rows = answered.conversations as SessionSummary[];

    expect({
      order: listOnly(answered),
      times: rows.map(row => `${typeof row.createdAt} ${typeof row.updatedAt}`),
      newest: rows[0]?.updatedAt,
    }).toEqual({
      order: ['newest', 'middle', 'oldest', idOf()],
      times: ['string string', 'string string', 'string string', 'string string'],
      newest: new Date(AHEAD + 2000).toISOString(),
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

  it('refuses the frame when the store cannot list, rather than reporting no conversations', async () => {
    const {url} = await startEngineWith({sessionStore: storeListing(storeOfThree()), history: enabled});

    const {reply} = asks(url, {type: 'list_conversations'}, 'error');

    expect(await reply).toEqual({
      type: 'error',
      code: 'UNSUPPORTED',
      message: 'This session store cannot list conversations',
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
      logged: [{category: 'message', message: 'conversation list failed', userId: 'u1', errorType: 'Error'}],
      leaked: false,
    });
  });

  it('reports the type of a rejection that is not an Error, rather than failing to describe it', async () => {
    const throwing = storeListing(storeOfThree(), () => Promise.reject('the driver threw a string'));
    const {url} = await startEngineWith({sessionStore: throwing, history: enabled});

    const {reply} = asks(url, {type: 'list_conversations'}, 'error');
    const answered = await reply;

    expect({code: answered.code, logged: errors.map(line => line.errorType)}).toEqual({
      code: 'SERVER_ERROR',
      logged: ['string'],
    });
  });

  it('answers a list while a turn is still streaming, rather than queueing behind it', async () => {
    const {url} = await startEngineWith({sessionStore: storeOfThree(), history: enabled});
    const client = connectClient(url);
    const seen: string[] = [];
    const bothSeen = new Promise<string[]>(resolve => {
      client.on('message', raw => {
        const {type} = JSON.parse(String(raw)) as Reply;
        seen.push(type);
        if (type === 'stream_end') resolve(seen);
      });
    });

    client.on('open', () => {
      client.send(JSON.stringify({type: 'user_message', content: 'hello'}));
      client.send(JSON.stringify({type: 'list_conversations'}));
    });
    const order = await bothSeen;

    expect(order.indexOf('conversation_list') < order.indexOf('stream_end')).toBe(true);
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
