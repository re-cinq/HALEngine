import {InMemorySessionStore} from './inMemorySessionStore.js';
import {MongoSessionStore} from './mongo/mongoSessionStore.js';
import {fakeCollection} from './mongo/mongoFakeCollection.js';
import {assertScalarUserId} from '../../types/session.js';

// Ids a decoded token can hand back that are no identity: a Mongo filter reads {$ne: null} as every user.
const UNUSABLE: unknown[] = [{$ne: null}, undefined, null, [], Number.NaN, Number.POSITIVE_INFINITY];

describe('a user id the stores cannot use as an identity', () => {
  it('is refused by assertScalarUserId for an operator object, undefined, null, an array, NaN and Infinity', () => {
    const refused = UNUSABLE.map(id => {
      try {
        assertScalarUserId(id);
        return 'accepted';
      } catch (error) {
        return (error as Error).message;
      }
    });

    expect({refused, accepted: [assertScalarUserId('u1'), assertScalarUserId(42)]}).toEqual({
      refused: [
        'user id must be a string or a finite number, not object',
        'user id must be a string or a finite number, not undefined',
        'user id must be a string or a finite number, not null',
        'user id must be a string or a finite number, not array',
        'user id must be a string or a finite number, not NaN',
        'user id must be a string or a finite number, not Infinity',
      ],
      accepted: [undefined, undefined],
    });
  });

  it('is refused by InMemorySessionStore create, listFor and latestFor, which hold nothing afterwards', () => {
    const store = new InMemorySessionStore();
    const refusals = UNUSABLE.flatMap(id =>
      [
        () => store.create('s', id as string),
        () => store.listFor(id as string),
        () => store.latestFor(id as string),
      ].map(call => {
        try {
          call();
          return 'answered';
        } catch {
          return 'refused';
        }
      })
    );

    expect({refusals: new Set(refusals), held: store.count()}).toEqual({refusals: new Set(['refused']), held: 0});
  });

  it('is refused by MongoSessionStore create, listFor and latestFor before any query reaches the collection', async () => {
    const queries: string[] = [];
    const record =
      (name: string, answer: unknown) =>
      (...args: unknown[]) => {
        queries.push(`${name} ${JSON.stringify(args[0])}`);
        return answer;
      };
    const store = new MongoSessionStore({
      collection: fakeCollection({
        findOne: record('findOne', Promise.resolve(null)) as never,
        find: record('find', {sort: () => ({limit: () => ({toArray: async () => []})})}) as never,
        updateOne: record('updateOne', Promise.resolve(undefined)) as never,
      }),
    });

    const calls = UNUSABLE.flatMap(id => [
      () => store.create('s', id as string),
      () => store.listFor(id as string),
      () => store.latestFor(id as string),
    ]);
    const outcomes = await Promise.all(
      calls.map(call =>
        call().then(
          () => 'answered',
          () => 'refused'
        )
      )
    );

    expect({outcomes: new Set(outcomes), queries}).toEqual({outcomes: new Set(['refused']), queries: []});
  });
});
