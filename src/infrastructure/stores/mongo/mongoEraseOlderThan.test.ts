import {MongoSessionStore} from './mongoSessionStore.js';
import {fakeCollection} from './mongoFakeCollection.js';
import {mongoCollection} from './mongoTestSupport.js';
import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

// eraseOlderThan must evict exactly the sessions it deleted, never a live session it never touched.

const oldDoc: MongoSessionDocument = {
  _id: 'old1',
  userId: 'u',
  entries: [],
  createdAt: new Date('2020-01-01'),
  updatedAt: new Date('2020-01-01'),
};

const sweeping = (overrides: Partial<CollectionLike<MongoSessionDocument>> = {}) =>
  fakeCollection({
    find: () => ({toArray: () => Promise.resolve([oldDoc])}),
    deleteMany: () => Promise.resolve({deletedCount: 1}),
    ...overrides,
  });

describe('eraseOlderThan selective cache eviction', () => {
  it('evicts only the sessions it deleted, leaving live ones in cache', async () => {
    const store = new MongoSessionStore({collection: sweeping()});
    const live = await store.create('live1', 'u');

    await store.eraseOlderThan(new Date('2021-01-01'));

    // The fake findOne answers null, so only a session still cached comes back from get.
    expect(await store.get('live1')).toBe(live);
  });

  it('evicts the sessions it deleted from the cache', async () => {
    const store = new MongoSessionStore({collection: sweeping()});
    await store.create('old1', 'u');

    await store.eraseOlderThan(new Date('2021-01-01'));

    expect(await store.get('old1')).toBeUndefined();
  });

  it('deletes exactly the ids it read, so what it deletes and what it evicts agree', async () => {
    const filters: Record<string, unknown>[] = [];
    const store = new MongoSessionStore({
      collection: sweeping({deleteMany: filter => (filters.push(filter), Promise.resolve({deletedCount: 1}))}),
    });

    await store.eraseOlderThan(new Date('2021-01-01'));

    expect(filters).toEqual([{_id: {$in: ['old1']}}]);
  });
});

describe('eraseOlderThan on a collection that implements no find', () => {
  it('empties the whole cache even when the delete rejects, since it may have applied', async () => {
    const store = new MongoSessionStore({
      collection: fakeCollection({deleteMany: () => Promise.reject(new Error('write concern timed out'))}),
    });
    await store.create('s1', 'u');

    const outcome = await store.eraseOlderThan(new Date('2021-01-01')).catch((error: Error) => error.message);

    expect({outcome, afterwards: await store.get('s1')}).toEqual({
      outcome: 'write concern timed out',
      afterwards: undefined,
    });
  });

  it('empties the whole cache once the delete succeeds, since it cannot tell which ids went', async () => {
    const store = new MongoSessionStore({
      collection: fakeCollection({deleteMany: () => Promise.resolve({deletedCount: 1})}),
    });
    await store.create('s1', 'u');

    await store.eraseOlderThan(new Date('2021-01-01'));

    expect(await store.get('s1')).toBeUndefined();
  });
});

describe('eraseOlderThan against a real collection', () => {
  const collectionFor = mongoCollection();

  it('deletes a backlog in batches of a thousand ids, so no single command can outgrow the size limit', async () => {
    const real = collectionFor();
    const at = new Date('2020-01-01T00:00:00.000Z');
    const backlog = Array.from({length: 2500}, (_, n) => ({
      _id: `s${String(n).padStart(4, '0')}`,
      userId: 'u',
      entries: [],
      createdAt: at,
      updatedAt: at,
    }));
    await real.insertMany(backlog);
    const batches: number[] = [];
    const counting = Object.assign(Object.create(real) as typeof real, {
      deleteMany: ({_id: {$in: ids}}: {_id: {$in: string[]}}) => (
        batches.push(ids.length),
        real.deleteMany({_id: {$in: ids}})
      ),
    }) as unknown as CollectionLike<MongoSessionDocument>;
    const store = new MongoSessionStore({collection: counting});

    const removed = await store.eraseOlderThan(new Date('2021-01-01T00:00:00.000Z'));

    expect({removed, batches, left: await real.countDocuments()}).toEqual({
      removed: 2500,
      batches: [1000, 1000, 500],
      left: 0,
    });
  });

  it('reads each page past the last id, so documents a delete leaves behind cannot hold the sweep in a loop', async () => {
    const real = collectionFor();
    const at = new Date('2020-01-01T00:00:00.000Z');
    await real.insertMany(
      Array.from({length: 1500}, (_, n) => ({_id: `s${n}`, userId: 'u', entries: [], createdAt: at, updatedAt: at}))
    );
    let deletes = 0;
    const refusing = Object.assign(Object.create(real) as typeof real, {
      deleteMany: () => (deletes++, Promise.resolve({deletedCount: 0})),
    }) as unknown as CollectionLike<MongoSessionDocument>;
    const store = new MongoSessionStore({collection: refusing});

    const removed = await store.eraseOlderThan(new Date('2021-01-01T00:00:00.000Z'));

    expect({removed, deletes}).toEqual({removed: 0, deletes: 2});
  });

  it('leaves a session created between its read and its delete both stored and cached', async () => {
    const real = collectionFor();
    // A create lands after the sweep has read its ids, as a concurrent connection's would.
    const racing = Object.assign(Object.create(real) as typeof real, {
      find: (filter: Record<string, unknown>, options?: Record<string, unknown>) => ({
        toArray: async () => {
          const ids = await real.find(filter, options).toArray();
          await store.create('late', 'u');
          return ids;
        },
      }),
    }) as unknown as CollectionLike<MongoSessionDocument>;
    const store = new MongoSessionStore({collection: racing, now: () => new Date('2020-01-01T00:00:00.000Z')});
    await store.create('early', 'u');

    const removed = await store.eraseOlderThan(new Date('2021-01-01T00:00:00.000Z'));

    expect({
      removed,
      cached: (await store.get('late'))?.sessionId,
      stored: await real.countDocuments({_id: 'late'}),
    }).toEqual({removed: 1, cached: 'late', stored: 1});
  });
});
