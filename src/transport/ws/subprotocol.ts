// The only subprotocol the server answers with, so the credential offered beside it never reaches a response header.
export const HAL_WS_SUBPROTOCOL = 'hal.v1';

// An offer without the marker is answered with nothing; ws and Chromium then fail the handshake on the client.
export function selectSubprotocol(offered: Set<string>): string | false {
  return offered.has(HAL_WS_SUBPROTOCOL) ? HAL_WS_SUBPROTOCOL : false;
}

// The first non-marker value, in whichever order the client offered them; no credential unless the marker was offered.
export function credentialFromSubprotocol(header: string | undefined): string | undefined {
  const values = header?.split(',').map(value => value.trim()) ?? [];
  if (!values.includes(HAL_WS_SUBPROTOCOL)) return undefined;
  return values.find(value => value.length > 0 && value !== HAL_WS_SUBPROTOCOL);
}
