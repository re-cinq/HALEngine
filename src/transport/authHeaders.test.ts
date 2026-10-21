import {filterAuthHeaders, forwardedHeaders} from './authHeaders.js';
import {setLogger} from '../shared/logger.js';
import {keepEveryLine} from '../shared/logCaptureTestSupport.js';

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
  it('forwards none while unset and logs nothing, and keeps a set list, an empty one too, as given', () => {
    const lines = keepEveryLine();

    const unset = [forwardedHeaders(undefined), forwardedHeaders(undefined)];
    const set = [forwardedHeaders([]), forwardedHeaders(['cookie'])];

    expect({unset, set, lines}).toEqual({unset: [[], []], set: [[], ['cookie']], lines: []});
  });
});
