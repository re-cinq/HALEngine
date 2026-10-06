import {assertScalarUserId} from './scalarUserId.js';

describe('assertScalarUserId', () => {
  it.each([
    ['non-empty string', 'u1'],
    ['empty string', ''],
    ['positive integer', 42],
    ['zero', 0],
    ['negative integer', -1],
  ] as [string, string | number][])('accepts userId: %s', (_label, id) => {
    expect(() => assertScalarUserId(id)).not.toThrow();
  });

  it('throws a TypeError for a non-scalar userId: object, null, undefined, array, NaN, or Infinity', () => {
    const nonScalars: unknown[] = [{$ne: null}, null, undefined, [], Number.NaN, Number.POSITIVE_INFINITY];
    for (const id of nonScalars) {
      expect(() => assertScalarUserId(id as string | number)).toThrow(TypeError);
    }
  });
});
