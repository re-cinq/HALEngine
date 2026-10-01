import {newSessionRequested, sessionIdFromUpgrade} from './helpers.js';

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

describe('newSessionRequested', () => {
  it('reads exactly ?new=1 inside the base path as a request for a new session, and nothing else', () => {
    expect({
      asked: newSessionRequested('/hal/ws?new=1', '/hal'),
      besideAnId: newSessionRequested('/hal/ws?sessionId=abc-123&new=1', '/hal'),
      absent: newSessionRequested('/hal/ws', '/hal'),
      zero: newSessionRequested('/hal/ws?new=0', '/hal'),
      word: newSessionRequested('/hal/ws?new=true', '/hal'),
      elsewhere: newSessionRequested('/elsewhere/ws?new=1', '/hal'),
      doubleSlash: newSessionRequested('//', '/hal'),
    }).toStrictEqual({
      asked: true,
      besideAnId: true,
      absent: false,
      zero: false,
      word: false,
      elsewhere: false,
      doubleSlash: false,
    });
  });
});
