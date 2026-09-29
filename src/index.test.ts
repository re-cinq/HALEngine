import {HAL_WS_SUBPROTOCOL, credentialFromSubprotocol} from './index.js';
import * as subprotocol from './transport/ws/subprotocol.js';

describe('the package root', () => {
  it('exports the hal.v1 marker with the reader a WsAuthenticator uses', () => {
    expect({marker: HAL_WS_SUBPROTOCOL, reader: credentialFromSubprotocol}).toEqual({
      marker: subprotocol.HAL_WS_SUBPROTOCOL,
      reader: subprotocol.credentialFromSubprotocol,
    });
  });
});
