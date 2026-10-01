import {isValidWsPath} from './helpers.js';

describe('isValidWsPath', () => {
  it('accepts any path beginning with /hal/ws and refuses another path, an empty target and //, without throwing', () => {
    expect({
      bare: isValidWsPath('/hal/ws', '/hal'),
      segment: isValidWsPath('/hal/ws/c1', '/hal'),
      prefixed: isValidWsPath('/hal/wsx', '/hal'),
      elsewhere: isValidWsPath('/other/ws', '/hal'),
      empty: isValidWsPath('', '/hal'),
      doubleSlash: isValidWsPath('//', '/hal'),
    }).toEqual({bare: true, segment: true, prefixed: true, elsewhere: false, empty: false, doubleSlash: false});
  });
});
