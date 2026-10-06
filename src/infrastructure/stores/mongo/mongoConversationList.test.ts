import {MongoSessionStore} from './mongoSessionStore.js';
import {fakeCollection, mongoCollection} from './mongoTestSupport.js';
import type {CollectionLike, FindManyOptions} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';
import type {SessionCursor} from '../../../types/sessionStore.js';

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
  fakeCollection({
    find: (filter: Record<string, unknown>, options?: FindManyOptions) => {
      calls.push({filter, options});
      return {toArray: () => Promise.resolve(documents)};
    },
    countDocuments: () => Promise.resolve(documents.length),
  });

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
      rest: (await store.listFor('u1', {before: firstPage[0]})).map(row => row.sessionId),
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

  it('asks the database to filter on the user, sort on the index with the id behind it, and never for the entries', async () => {
    const calls: RecordedFind[] = [];
    const store = new MongoSessionStore({collection: recordingCollection(calls, [])});
    const updatedAt = new Date(START);

    await store.listFor('u1', {limit: 7, before: {updatedAt, sessionId: 's9'}});

    expect(calls).toEqual([
      {
        filter: {userId: 'u1', $or: [{updatedAt: {$lt: updatedAt}}, {updatedAt, _id: {$lt: 's9'}}]},
        options: {
          sort: {updatedAt: -1, _id: -1},
          limit: 7,
          projection: {_id: 1, createdAt: 1, updatedAt: 1, entryCount: 1},
        },
      },
    ]);
  });

  it('keeps a conversation tied on updatedAt rather than dropping it across a page boundary', async () => {
    const store = new MongoSessionStore({collection: collectionFor(), now: () => new Date(START)});
    await store.create('a', 'u1');
    await store.create('b', 'u1');
    await store.create('c', 'u1');

    const pages: string[][] = [];
    let page = await store.listFor('u1', {limit: 1});
    while (page.length > 0) {
      pages.push(page.map(row => row.sessionId));
      page = await store.listFor('u1', {limit: 1, before: page[0]});
    }

    expect(pages).toEqual([['c'], ['b'], ['a']]);
  });

  it('answers a limit of none without asking the database, which reads a limit of zero as no limit at all', async () => {
    const calls: RecordedFind[] = [];
    const store = new MongoSessionStore({collection: recordingCollection(calls, [])});

    expect({rows: await store.listFor('u1', {limit: 0}), queries: calls.length}).toEqual({rows: [], queries: 0});
  });

  it('pages on a cursor that has been through JSON, where a string would have matched no stored date', async () => {
    let clock = START;
    const store = new MongoSessionStore({collection: collectionFor(), now: () => new Date(clock)});
    await store.create('older', 'u1');
    clock += 1000;
    await store.create('newer', 'u1');
    const roundTripped = JSON.parse(JSON.stringify((await store.listFor('u1', {limit: 1}))[0])) as SessionCursor;

    expect((await store.listFor('u1', {before: roundTripped})).map(row => row.sessionId)).toEqual(['older']);
  });

  it('heads the list with the session latestFor returns even when every conversation shares an updatedAt', async () => {
    const store = new MongoSessionStore({collection: collectionFor(), now: () => new Date(START)});
    await store.create('s1', 'u1');
    await store.create('s2', 'u1');
    await store.create('s3', 'u1');

    const listed = await store.listFor('u1');

    expect({head: listed[0]?.sessionId, latest: (await store.latestFor('u1'))?.sessionId}).toEqual({
      head: 's3',
      latest: 's3',
    });
  });

  it('refuses to list on a collection that implements no find, rather than reporting no conversations', async () => {
    const store = new MongoSessionStore({collection: fakeCollection()});

    await expect(store.listFor('u1')).rejects.toThrow('implements no find, so it cannot list conversations');
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

  it('needs the three-key index to answer without sorting the whole history, which the two-key form does not', async () => {
    const collection = collectionFor();
    const at = new Date(START);
    await collection.insertMany(
      Array.from({length: 50}, (_unused, index) => ({
        _id: `s${index}`,
        userId: 'u1',
        entries: [],
        createdAt: at,
        updatedAt: new Date(START + index * 1000),
      }))
    );
    // The query the store issues, projection included: a narrower one would be covered and measure nothing real.
    const listQuery = {
      sort: {updatedAt: -1 as const, _id: -1 as const},
      limit: 5,
      projection: {_id: 1 as const, createdAt: 1 as const, updatedAt: 1 as const, entryCount: 1 as const},
    };

    await collection.createIndex({userId: 1, updatedAt: -1});
    const twoKey = await collection.find({userId: 'u1'}, listQuery).explain('executionStats');
    await collection.dropIndexes();
    await collection.createIndex({userId: 1, updatedAt: -1, _id: -1});
    const threeKey = await collection.find({userId: 'u1'}, listQuery).explain('executionStats');

    expect({
      twoKeySorts: JSON.stringify(twoKey.queryPlanner.winningPlan).includes('"SORT"'),
      twoKeyExamined: twoKey.executionStats.totalDocsExamined,
      threeKeySorts: JSON.stringify(threeKey.queryPlanner.winningPlan).includes('"SORT"'),
      threeKeyExamined: threeKey.executionStats.totalDocsExamined,
    }).toEqual({twoKeySorts: true, twoKeyExamined: 50, threeKeySorts: false, threeKeyExamined: 5});
  });

  it('rejects rather than answering a partial list when the collection fails', async () => {
    const failing = fakeCollection({
      find: () => ({toArray: () => Promise.reject(new Error('database unreachable'))}),
    });
    const store = new MongoSessionStore({collection: failing});

    await expect(store.listFor('u1')).rejects.toThrow('database unreachable');
  });
});
