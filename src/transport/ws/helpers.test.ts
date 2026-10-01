import {sessionIdFromUpgrade} from './helpers.js';

const read = (url: string): string | undefined => sessionIdFromUpgrade(url, '/hal');

describe('sessionIdFromUpgrade', () => {
  it('reads abc-123 from the query and nothing from a bare path, a path segment, an empty, a 129-character or a traversal value', () => {
    expect({
      query: read('/hal/ws?sessionId=abc-123'),
      bare: read('/hal/ws'),
      segment: read('/hal/ws/abc-123'),
      empty: read('/hal/ws?sessionId='),
      tooLong: read(`/hal/ws?sessionId=${'a'.repeat(129)}`),
      traversal: read('/hal/ws?sessionId=../etc/passwd'),
    }).toStrictEqual({
      query: 'abc-123',
      bare: undefined,
      segment: undefined,
      empty: undefined,
      tooLong: undefined,
      traversal: undefined,
    });
  });

  it('reads a 128-character id, the longest it accepts', () => {
    const longest = 'a'.repeat(128);

    expect(read(`/hal/ws?sessionId=${longest}`)).toBe(longest);
  });

  it('reads nothing from an upgrade outside the base path', () => {
    expect(read('/elsewhere/ws?sessionId=abc-123')).toBeUndefined();
  });

  it('reads nothing, without throwing, from a target that is not a URL or is empty', () => {
    expect({doubleSlash: read('//'), empty: read('')}).toStrictEqual({doubleSlash: undefined, empty: undefined});
  });
});
