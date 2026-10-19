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

  it('never caches a session read while its eraseConversation was still deleting it', async () => {
    const deleted = gate<DeleteOutcome>();
    const store = new MongoSessionStore({
      collection: fakeCollection({
        findOne: () => Promise.resolve(stored),
        deleteOne: () => deleted.wait,
      }),
    });

    const erasing = store.eraseConversation('s1');
    await store.get('s1');
    deleted.open({deletedCount: 1});
    await erasing;

    expect(store['cache'].has('s1')).toBe(false);
  });

  it('keeps no record of an erasure once it completes, so memory does not grow with erasures', async () => {
    const store = new MongoSessionStore({collection: fakeCollection()});

    await Promise.all(['a', 'b', 'c'].map(id => store.eraseConversation(id)));

    expect({inFlight: store['inFlightGets'].size, cached: store['cache'].size}).toEqual({inFlight: 0, cached: 0});
  });
});
