import type {IncomingMessage} from 'node:http';
import {presentedCredential} from './credential.js';

// Only the two carriers matter: the Authorization header and the offered subprotocols.
const upgrade = (headers: {authorization?: string; 'sec-websocket-protocol'?: string}) =>
  ({headers}) as IncomingMessage;

describe('presentedCredential', () => {
  it('returns Bearer t-1 when both carriers hold t-1, and refuses Bearer t-1 beside a subprotocol t-2', () => {
    expect([
      presentedCredential(upgrade({authorization: 'Bearer t-1', 'sec-websocket-protocol': 'hal.v1, t-1'})),
      presentedCredential(upgrade({authorization: 'Bearer t-1', 'sec-websocket-protocol': 'hal.v1, t-2'})),
    ]).toEqual([{ok: true, value: 'Bearer t-1'}, {ok: false}]);
  });

  it('returns no value for neither carrier, and the one value when only the header or only the subprotocol holds it', () => {
    expect([
      presentedCredential(upgrade({})),
      presentedCredential(upgrade({authorization: 'Bearer from-header'})),
      presentedCredential(upgrade({'sec-websocket-protocol': 'hal.v1, from-offer'})),
    ]).toEqual([
      {ok: true, value: undefined},
      {ok: true, value: 'Bearer from-header'},
      {ok: true, value: 'Bearer from-offer'},
    ]);
  });

  it('refuses Basic t-1 beside a subprotocol t-1, another scheme being another credential', () => {
    expect(presentedCredential(upgrade({authorization: 'Basic t-1', 'sec-websocket-protocol': 'hal.v1, t-1'}))).toEqual(
      {ok: false}
    );
  });

  it('refuses a lowercase bearer t-1 beside a subprotocol t-1, the comparison being exact', () => {
    expect(
      presentedCredential(upgrade({authorization: 'bearer t-1', 'sec-websocket-protocol': 'hal.v1, t-1'}))
    ).toEqual({ok: false});
  });

  it('reads the subprotocol credential only beside hal.v1, so a markerless t-2 leaves the header Bearer t-1 standing alone', () => {
    expect(presentedCredential(upgrade({authorization: 'Bearer t-1', 'sec-websocket-protocol': 't-2'}))).toEqual({
      ok: true,
      value: 'Bearer t-1',
    });
  });
});
