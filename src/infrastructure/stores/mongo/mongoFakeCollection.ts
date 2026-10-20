import type {CollectionLike} from './mongoDriverTypes.js';
import type {MongoSessionDocument} from './mongoSessionDocument.js';

/** A collection that answers nothing, for the suites that need one member to misbehave; override just that member. */
export function fakeCollection(
  overrides: Partial<CollectionLike<MongoSessionDocument>> = {}
): CollectionLike<MongoSessionDocument> {
  return {
    findOne: () => Promise.resolve(null),
    updateOne: () => Promise.resolve(undefined),
    deleteOne: () => Promise.resolve({deletedCount: 0}),
    deleteMany: () => Promise.resolve({deletedCount: 0}),
    countDocuments: () => Promise.resolve(0),
    ...overrides,
  } as CollectionLike<MongoSessionDocument>;
}
