import {isValidWsPath} from './helpers.js';

describe('isValidWsPath', () => {
  it('accepts /hal/ws with or without a trailing segment and refuses another path, an empty target and //, without throwing', () => {
    expect({
      bare: isValidWsPath('/hal/ws', '/hal'),
      segment: isValidWsPath('/hal/ws/c1', '/hal'),
      elsewhere: isValidWsPath('/other/ws', '/hal'),
      empty: isValidWsPath('', '/hal'),
      doubleSlash: isValidWsPath('//', '/hal'),
    }).toEqual({bare: true, segment: true, elsewhere: false, empty: false, doubleSlash: false});
  });
});
