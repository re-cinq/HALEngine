import {MongoSessionStore} from './mongoSessionStore.js';
import {fakeCollection} from './mongoFakeCollection.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';
import type {DeleteOutcome} from './mongoDriverTypes.js';

// An erasure has to withdraw every read still waiting on the collection, or the read re-caches what was erased.

const stored: MongoSessionDocument = {
  _id: 's1',
  userId: 'u1',
  entries: [],
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  updatedAt: new Date('2020-01-01T00:00:00.000Z'),
};

function gate<T>(): {wait: Promise<T>; open: (value: T) => void} {
  let open!: (value: T) => void;
  const wait = new Promise<T>(resolve => {
    open = resolve;
  });
  return {wait, open};
}

// Counts reads, so a test can tell a session served from the cache from one fetched again.
function countingReads(document: MongoSessionDocument | null): {
  reads: () => number;
  findOne: () => Promise<typeof document>;
} {
  let reads = 0;
  return {reads: () => reads, findOne: () => (reads++, Promise.resolve(document))};
}

// Starts a read once the erasure's delete is pending, settles the delete and then the read, and reports what got cached.
async function cachedAfterReadDuringDelete(
  erase: (store: MongoSessionStore) => Promise<unknown>,
  deleteMember: 'deleteOne' | 'deleteMany'
): Promise<boolean> {
  const deleting = gate<void>();
  const deleted = gate<DeleteOutcome>();
  const read = gate<MongoSessionDocument | null>();
  const store = new MongoSessionStore({
    collection: fakeCollection({
      find: () => ({toArray: () => Promise.resolve([stored])}),
      findOne: () => read.wait,
      [deleteMember]: () => (deleting.open(), deleted.wait),
    }),
  });

  const erasing = erase(store);
  await deleting.wait;
  const pending = store.get('s1');
  deleted.open({deletedCount: 1});
  await erasing;
  read.open(stored);
  await pending;
  return store['cache'].has('s1');
}

describe('a get racing an erasure', () => {
  it('never re-caches a session eraseAll removed while the read was waiting', async () => {
    const read = gate<MongoSessionDocument | null>();
    const store = new MongoSessionStore({
      collection: fakeCollection({
        findOne: () => read.wait,
        deleteMany: () => Promise.resolve({deletedCount: 1}),
      }),
    });

    const pending = store.get('s1');
    await store.eraseAll();
    read.open(stored);
    const returned = await pending;

    expect({returned: returned?.sessionId, cached: store['cache'].has('s1')}).toEqual({returned: 's1', cached: false});
  });

  it('withdraws a read begun while the delete was pending and still waiting when the delete resolved', async () => {
    expect(await cachedAfterReadDuringDelete(store => store.eraseConversation('s1'), 'deleteOne')).toBe(false);
  });

  it('drops a read begun while the delete was pending that finished before the delete resolved', async () => {
    const deleted = gate<DeleteOutcome>();
    const store = new MongoSessionStore({
      collection: fakeCollection({findOne: () => Promise.resolve(stored), deleteOne: () => deleted.wait}),
    });

    const erasing = store.eraseConversation('s1');
    await store.get('s1');
    deleted.open({deletedCount: 1});
    await erasing;

    expect(store['cache'].has('s1')).toBe(false);
  });

  it('withdraws a read begun while an eraseOlderThan batch was deleting and still waiting when it resolved', async () => {
    const sweep = (store: MongoSessionStore) => store.eraseOlderThan(new Date('2021-01-01T00:00:00.000Z'));
    expect(await cachedAfterReadDuringDelete(sweep, 'deleteMany')).toBe(false);
  });

  it('leaves a pending read of another session to cache what it finds', async () => {
    const read = gate<MongoSessionDocument | null>();
    const store = new MongoSessionStore({collection: fakeCollection({findOne: () => read.wait})});

    const pending = store.get('s1');
    await store.eraseConversation('other');
    read.open(stored);
    await pending;

    expect(store['cache'].has('s1')).toBe(true);
  });

  it('lets a later read cache an id it erased, so it keeps no record of erasures', async () => {
    const collection = countingReads(stored);
    const store = new MongoSessionStore({collection: fakeCollection({findOne: collection.findOne})});

    await store.eraseConversation('s1');
    await store.get('s1');
    await store.get('s1');

    expect(collection.reads()).toBe(1);
  });
});

describe('an erasure whose delete rejects', () => {
  // Erases a cached session through a collection whose deletes all reject, then reads it back.
  async function afterRejectedErasure(erase: (store: MongoSessionStore) => Promise<unknown>) {
    const collection = countingReads(null);
    const refused = () => Promise.reject(new Error('write concern timed out'));
    const store = new MongoSessionStore({
      collection: fakeCollection({findOne: collection.findOne, deleteOne: refused, deleteMany: refused}),
    });
    await store.create('s1', 'u1');

    const outcome = await erase(store).catch((error: Error) => error.message);
    const afterwards = await store.get('s1');
    return {outcome, afterwards, reads: collection.reads()};
  }

  const refusedAndDropped = {outcome: 'write concern timed out', afterwards: undefined, reads: 1};

  it('still drops the conversation from the cache on eraseConversation, since the delete may have landed', async () => {
    expect(await afterRejectedErasure(store => store.eraseConversation('s1'))).toEqual(refusedAndDropped);
  });

  it('still empties the cache on eraseAll, since some documents may have gone', async () => {
    expect(await afterRejectedErasure(store => store.eraseAll())).toEqual(refusedAndDropped);
  });
});
