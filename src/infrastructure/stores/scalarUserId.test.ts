import {assertScalarUserId} from './scalarUserId.js';

describe('assertScalarUserId', () => {
  it('accepts a string or finite-number userId', () => {
    for (const id of ['u1', '', 42, 0, -1] as (string | number)[]) {
      expect(() => assertScalarUserId(id)).not.toThrow();
    }
  });

  it('throws a TypeError for a non-scalar userId: object, null, undefined, array, NaN, or Infinity', () => {
    const nonScalars: unknown[] = [{$ne: null}, null, undefined, [], Number.NaN, Number.POSITIVE_INFINITY];
    for (const id of nonScalars) {
      expect(() => assertScalarUserId(id as string | number)).toThrow(TypeError);
    }
  });
});
