import {log} from '../../shared/logger.js';

// The only subprotocol the server answers with, so the credential offered beside it never reaches a response header.
export const HAL_WS_SUBPROTOCOL = 'hal.v1';

// Deprecated shape, kept for one MINOR: a bare-token offer is echoed as before, because ws and Chromium fail a handshake answered with nothing.
export function selectSubprotocol(offered: Set<string>): string | false {
  if (offered.has(HAL_WS_SUBPROTOCOL)) return HAL_WS_SUBPROTOCOL;
  const [first] = offered;
  if (!first) return false;
  log.warn('ws', `subprotocol offered without ${HAL_WS_SUBPROTOCOL}; the offer is echoed until the next minor release`);
  return first;
}

// The first non-marker value, in whichever order the client offered them.
export function credentialFromSubprotocol(header: string | undefined): string | undefined {
  return header
    ?.split(',')
    .map(value => value.trim())
    .find(value => value.length > 0 && value !== HAL_WS_SUBPROTOCOL);
}
