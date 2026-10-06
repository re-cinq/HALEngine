import {MongoSessionStore} from './mongoSessionStore.js';
import {mongoCollection} from './mongoTestSupport.js';
import type {CollectionLike, FindManyOptions} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// One query, filtered and sorted in the database, and projected so no conversation leaves it to be counted.

const START = Date.parse('2026-01-01T00:00:00.000Z');

interface RecordedFind {
  filter: Record<string, unknown>;
  options?: FindManyOptions;
}

const recordingCollection = (
  calls: RecordedFind[],
  documents: MongoSessionDocument[]
): CollectionLike<MongoSessionDocument> =>
  ({
    findOne: () => Promise.resolve(null),
    find: (filter: Record<string, unknown>, options?: FindManyOptions) => {
      calls.push({filter, options});
      return {toArray: () => Promise.resolve(documents)};
    },
    updateOne: () => Promise.resolve(undefined),
    deleteOne: () => Promise.resolve({deletedCount: 0}),
    deleteMany: () => Promise.resolve({deletedCount: 0}),
    countDocuments: () => Promise.resolve(documents.length),
  }) as CollectionLike<MongoSessionDocument>;

describe('the MongoDB store conversation list', () => {
  const collectionFor = mongoCollection();

  it("answers the user's conversations newest saved first, headed by the one latestFor returns", async () => {
    let clock = START;
    const store = new MongoSessionStore({collection: collectionFor(), now: () => new Date(clock)});
    const older = await store.create('older', 'u1');
    clock += 1000;
    await store.create('newer', 'u1');
    await store.create('theirs', 'u2');
    clock += 1000;
    await store.save(older);

    const listed = await store.listFor('u1');

    expect({
      order: listed.map(row => row.sessionId),
      heads: listed[0]?.sessionId === (await store.latestFor('u1'))?.sessionId,
    }).toEqual({order: ['older', 'newer'], heads: true});
  });

  it('reports the creation time, the last save and the entry count of each conversation', async () => {
    let clock = START;
    const store = new MongoSessionStore({collection: collectionFor(), now: () => new Date(clock)});
    const session = await store.create('s1', 'u1');
    clock += 5000;
    session.entries.push({role: 'user', content: 'hello', timestamp: new Date(clock).toISOString()});
    await store.save(session);

    expect(await store.listFor('u1')).toEqual([
      {sessionId: 's1', createdAt: new Date(START), updatedAt: new Date(START + 5000), entryCount: 1},
    ]);
  });

  it('pages with before and a limit, down the same newest-first order', async () => {
    let clock = START;
    const store = new MongoSessionStore({collection: collectionFor(), now: () => new Date(clock)});
    await store.create('oldest', 'u1');
    clock += 1000;
    await store.create('middle', 'u1');
    clock += 1000;
    await store.create('newest', 'u1');

    const firstPage = await store.listFor('u1', {limit: 1});

    expect({
      firstPage: firstPage.map(row => row.sessionId),
      rest: (await store.listFor('u1', {before: firstPage[0]?.updatedAt})).map(row => row.sessionId),
    }).toEqual({firstPage: ['newest'], rest: ['middle', 'oldest']});
  });

  it('reads a conversation saved before the counter existed as one of no entries, rather than failing', async () => {
    const collection = collectionFor();
    await collection.insertOne({
      _id: 'legacy',
      userId: 'u1',
      entries: [{role: 'user', content: 'hello', timestamp: new Date(START).toISOString()}],
      createdAt: new Date(START),
      updatedAt: new Date(START),
    });
    const store = new MongoSessionStore({collection});

    expect(await store.listFor('u1')).toEqual([
      {sessionId: 'legacy', createdAt: new Date(START), updatedAt: new Date(START), entryCount: 0},
    ]);
  });

  it('counts a conversation from the field a save writes beside the entries', async () => {
    const collection = collectionFor();
    const store = new MongoSessionStore({collection});
    const session = await store.create('s1', 'u1');
    session.entries.push(
      {role: 'user', content: 'hello', timestamp: new Date(START).toISOString()},
      {role: 'thinking', content: 'pondering', isStreaming: false}
    );
    await store.save(session);

    expect((await collection.findOne({_id: 's1'}))?.entryCount).toBe(2);
  });

  it('asks the database to filter on the user and sort on the resume index, and never for the entries', async () => {
    const calls: RecordedFind[] = [];
    const store = new MongoSessionStore({collection: recordingCollection(calls, [])});
    const before = new Date(START);

    await store.listFor('u1', {limit: 7, before});

    expect(calls).toEqual([
      {
        filter: {userId: 'u1', updatedAt: {$lt: before}},
        options: {sort: {updatedAt: -1}, limit: 7, projection: {_id: 1, createdAt: 1, updatedAt: 1, entryCount: 1}},
      },
    ]);
  });

  it('answers from a projection alone, so a collection that never returns entries still lists conversations', async () => {
    const projected = [
      {_id: 's1', createdAt: new Date(START), updatedAt: new Date(START), entryCount: 3},
    ] as unknown as MongoSessionDocument[];
    const store = new MongoSessionStore({collection: recordingCollection([], projected)});

    expect(await store.listFor('u1')).toEqual([
      {sessionId: 's1', createdAt: new Date(START), updatedAt: new Date(START), entryCount: 3},
    ]);
  });

  it('rejects rather than answering a partial list when the collection fails', async () => {
    const failing = {
      findOne: () => Promise.resolve(null),
      find: () => ({toArray: () => Promise.reject(new Error('database unreachable'))}),
      updateOne: () => Promise.resolve(undefined),
      deleteOne: () => Promise.resolve({deletedCount: 0}),
      deleteMany: () => Promise.resolve({deletedCount: 0}),
      countDocuments: () => Promise.resolve(0),
    } as CollectionLike<MongoSessionDocument>;
    const store = new MongoSessionStore({collection: failing});

    await expect(store.listFor('u1')).rejects.toThrow('database unreachable');
  });
});
