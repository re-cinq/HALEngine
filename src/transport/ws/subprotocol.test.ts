import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {HAL_WS_SUBPROTOCOL, credentialFromSubprotocol, selectSubprotocol} from './subprotocol.js';

const TOKEN = 'super-secret-token';

const doc = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

describe('the hal.v1 marker', () => {
  it('is the literal the protocol spec and the getting-started client print', () => {
    const printed = {
      spec: doc('specs/hal-engine-websocket-protocol/spec.md').includes(
        `Sec-WebSocket-Protocol: ${HAL_WS_SUBPROTOCOL}, <access-token>`
      ),
      client: doc('docs/getting-started.md').includes(`['${HAL_WS_SUBPROTOCOL}', token]`),
    };

    expect({marker: HAL_WS_SUBPROTOCOL, printed}).toEqual({marker: 'hal.v1', printed: {spec: true, client: true}});
  });
});

describe('selectSubprotocol', () => {
  it('answers the marker when it is offered first, never the token beside it', () => {
    expect(selectSubprotocol(new Set([HAL_WS_SUBPROTOCOL, TOKEN]))).toBe(HAL_WS_SUBPROTOCOL);
  });

  it('answers the marker when it is offered after the token', () => {
    expect(selectSubprotocol(new Set([TOKEN, HAL_WS_SUBPROTOCOL]))).toBe(HAL_WS_SUBPROTOCOL);
  });

  it('answers nothing for a bare token offered without the marker', () => {
    expect(selectSubprotocol(new Set([TOKEN]))).toBe(false);
  });

  it('answers nothing for an empty offer', () => {
    expect(selectSubprotocol(new Set())).toBe(false);
  });
});

describe('credentialFromSubprotocol', () => {
  it('reads the token from a marker-first offer', () => {
    expect(credentialFromSubprotocol(`${HAL_WS_SUBPROTOCOL}, ${TOKEN}`)).toBe(TOKEN);
  });

  it('reads the token from a token-first offer', () => {
    expect(credentialFromSubprotocol(`${TOKEN}, ${HAL_WS_SUBPROTOCOL}`)).toBe(TOKEN);
  });

  it('reads the first non-marker value when two are offered beside the marker', () => {
    expect(credentialFromSubprotocol(`${HAL_WS_SUBPROTOCOL}, first, second`)).toBe('first');
  });

  it('reads nothing from a bare token offered without the marker', () => {
    expect(credentialFromSubprotocol(TOKEN)).toBeUndefined();
  });

  it('reads nothing when only the marker is offered', () => {
    expect(credentialFromSubprotocol(HAL_WS_SUBPROTOCOL)).toBeUndefined();
  });

  it('reads nothing when no subprotocol header was sent', () => {
    expect(credentialFromSubprotocol(undefined)).toBeUndefined();
  });
});
