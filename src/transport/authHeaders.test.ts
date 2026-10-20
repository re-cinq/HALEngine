import {filterAuthHeaders, forwardedHeaders} from './authHeaders.js';
import {setLogger} from '../shared/logger.js';

const CAPTURED = {cookie: 'sid=cookie-7f3a', authorization: 'Bearer token-9c2e', host: 'tenant-4b1d.example'};

afterAll(() => setLogger());

describe('filterAuthHeaders', () => {
  it('keeps authorization alone, under exactly one key, when only authorization is allowed from cookie, authorization and host', () => {
    const kept = filterAuthHeaders(CAPTURED, ['authorization']);

    expect({keys: Object.keys(kept ?? {}), kept}).toEqual({
      keys: ['authorization'],
      kept: {authorization: 'Bearer token-9c2e'},
    });
  });

  it('returns undefined, never an empty object, for an empty allowlist and for one selecting only a cookie the caller never sent', () => {
    expect({
      empty: filterAuthHeaders(CAPTURED, []),
      unsent: filterAuthHeaders({authorization: 'Bearer token-9c2e'}, ['cookie']),
    }).toEqual({empty: undefined, unsent: undefined});
  });
});

describe('forwardedHeaders', () => {
  it('forwards all three while unset and warns once per process naming auth.forwardHeaders and 0.10.0, keeping a set list, an empty one too, silently', () => {
    const warnings: unknown[] = [];
    const quiet = () => undefined;
    setLogger({
      debug: quiet,
      info: quiet,
      warn: (category, message, fields) => void warnings.push({category, ...fields}),
      error: quiet,
    });

    const unset = [forwardedHeaders(undefined), forwardedHeaders(undefined)];
    const set = [forwardedHeaders([]), forwardedHeaders(['cookie'])];

    expect({unset, set, warnings}).toEqual({
      unset: [
        ['cookie', 'authorization', 'host'],
        ['cookie', 'authorization', 'host'],
      ],
      set: [[], ['cookie']],
      warnings: [{category: 'auth', setting: 'auth.forwardHeaders', forwardsNoneFrom: '0.10.0'}],
    });
  });
});
