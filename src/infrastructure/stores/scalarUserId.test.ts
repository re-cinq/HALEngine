import {assertScalarUserId} from './scalarUserId.js';

describe('assertScalarUserId', () => {
  it('accepts a string or finite-number userId', () => {
    expect(() => assertScalarUserId('u1')).not.toThrow();
    expect(() => assertScalarUserId('')).not.toThrow();
    expect(() => assertScalarUserId(42)).not.toThrow();
    expect(() => assertScalarUserId(0)).not.toThrow();
    expect(() => assertScalarUserId(-1)).not.toThrow();
  });

  it('throws a TypeError for a non-scalar userId: object, null, undefined, array, NaN, or Infinity', () => {
    const nonScalars: unknown[] = [{$ne: null}, null, undefined, [], Number.NaN, Number.POSITIVE_INFINITY];
    for (const id of nonScalars) {
      expect(() => assertScalarUserId(id as string | number)).toThrow(TypeError);
    }
  });
});
