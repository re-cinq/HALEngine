import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {HAL_WS_SUBPROTOCOL, credentialFromSubprotocol} from './index.js';
import * as root from './index.js';
import * as subprotocol from './transport/ws/subprotocol.js';

describe('the package root', () => {
  it('exports the hal.v1 marker with the reader a WsAuthenticator uses', () => {
    expect({marker: HAL_WS_SUBPROTOCOL, reader: credentialFromSubprotocol}).toEqual({
      marker: subprotocol.HAL_WS_SUBPROTOCOL,
      reader: subprotocol.credentialFromSubprotocol,
    });
  });

  it('keeps presentedCredential and the module it lives in out of the package root', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');

    expect({exported: 'presentedCredential' in root, imported: source.includes('ws/credential')}).toEqual({
      exported: false,
      imported: false,
    });
  });
});
