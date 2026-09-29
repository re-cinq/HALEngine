import {MongoSessionStore} from './mongoSessionStore.js';
import {stripCredentialKeys} from './mongoSessionDocument.js';
import {mongoCollection} from './mongoTestSupport.js';
import type {ChatSession} from '../../../types/session.js';

// A bearer token serialised beside a conversation outlives the request it was issued for.

const SENT_AT = '2026-01-01T00:00:00.000Z';

// Walks the whole document: a top-level check would miss a token the model put inside a tool's input.
const keysOf = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const element of value) keysOf(element, found);
    return found;
  }
  if (typeof value !== 'object' || value === null) return found;

  for (const [key, nested] of Object.entries(value)) {
    found.push(key.toLowerCase());
    keysOf(nested, found);
  }
  return found;
};

const sessionCarryingCredentials = (): ChatSession => ({
  sessionId: 's1',
  userId: 'u1',
  authHeaders: {authorization: 'Bearer secret', cookie: 'sid=1', host: 'example.com'},
  entries: [
    {role: 'user', content: 'hello', timestamp: SENT_AT},
    {
      role: 'tool',
      toolName: 'lookup',
      toolInput: {headers: {Authorization: 'Bearer nested'}, deeper: [{cookie: 'sid=2'}], keep: 'Bearer-looking'},
      timestamp: SENT_AT,
    },
  ],
});

describe('what a persisted session may not contain', () => {
  const collectionFor = mongoCollection();

  it('holds no credential key at any depth of the stored document', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});

    await store.save(sessionCarryingCredentials());
    const stored = await collectionFor().findOne({_id: 's1'});
    const keys = keysOf(JSON.parse(JSON.stringify(stored)) as unknown);

    expect(keys.filter(key => ['authheaders', 'authorization', 'cookie', 'host'].includes(key))).toEqual([]);
  });

  it('keeps everything that is not a credential, so the redaction is not simply emptying the document', async () => {
    const store = new MongoSessionStore({collection: collectionFor()});

    await store.save(sessionCarryingCredentials());
    const stored = await collectionFor().findOne({_id: 's1'});

    expect({
      entries: stored?.entries.length,
      kept: (stored?.entries[1] as {toolInput: {keep: string}} | undefined)?.toolInput.keep,
    }).toEqual({entries: 2, kept: 'Bearer-looking'});
  });

  it('leaves the caller their in-memory credentials, which the tools still need', () => {
    const session = sessionCarryingCredentials();

    stripCredentialKeys(session);

    expect(session.authHeaders?.authorization).toBe('Bearer secret');
  });
});
