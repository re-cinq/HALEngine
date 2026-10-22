import {MongoSessionStore} from './mongoSessionStore.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';
import {mongoCollection} from './mongoTestSupport.js';

const CREATED = new Date('2026-10-20T08:00:00.000Z');

describe('ChatSession.createdAt from MongoDB', () => {
  const collectionFor = mongoCollection();

  it("sets createdAt to the document's creation time, 2026-10-20T08:00:00.000Z, on create and on a second store's read", async () => {
    const created = await new MongoSessionStore({collection: collectionFor(), now: () => CREATED}).create('s1', 'u1');

    const reread = await new MongoSessionStore({collection: collectionFor()}).get('s1');
    const stored = await collectionFor().findOne({_id: 's1'});

    expect({created: created.createdAt, reread: reread?.createdAt, stored: stored?.createdAt}).toEqual({
      created: '2026-10-20T08:00:00.000Z',
      reread: '2026-10-20T08:00:00.000Z',
      stored: CREATED,
    });
  });

  it('reads a document that holds no createdAt back as a session with no createdAt key', async () => {
    const old = {_id: 's-old', userId: 'u1', entries: []} as unknown as MongoSessionDocument;
    await collectionFor().insertOne(old);

    const session = await new MongoSessionStore({collection: collectionFor()}).get('s-old');

    expect({found: session !== undefined, hasKey: Object.hasOwn(session ?? {}, 'createdAt')}).toEqual({
      found: true,
      hasKey: false,
    });
  });
});
