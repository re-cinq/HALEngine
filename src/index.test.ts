import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {HAL_WS_SUBPROTOCOL, credentialFromSubprotocol} from './index.js';
import * as root from './index.js';
import * as subprotocol from './transport/ws/subprotocol.js';
import {recordedFrames as fromRoot} from './index.js';
import {recordedFrames} from './testing/frames.js';

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

  it('exports recordedFrames as the constant src/testing/frames.ts holds, its simpleAnswer an array', () => {
    expect({same: fromRoot === recordedFrames, array: Array.isArray(fromRoot.simpleAnswer)}).toEqual({
      same: true,
      array: true,
    });
  });
});
