import type {IncomingMessage} from 'node:http';
import {credentialFromSubprotocol} from './subprotocol.js';

/** At most one credential an upgrade presents, or `ok: false` when its two carriers name different ones. */
export type PresentedCredential = {ok: true; value?: string} | {ok: false};

/** The one credential an upgrade presents, read from `Authorization` or the subprotocol, which must agree when both are set. */
export function presentedCredential(req: IncomingMessage): PresentedCredential {
  const header = req.headers.authorization || undefined;
  const offered = credentialFromSubprotocol(req.headers['sec-websocket-protocol']);
  const fromSubprotocol = offered === undefined ? undefined : `Bearer ${offered}`;
  // Byte for byte: another scheme or a lowercase `bearer` is another credential, and an RFC 6455 token holds no space.
  if (header !== undefined && fromSubprotocol !== undefined && header !== fromSubprotocol) return {ok: false};
  return {ok: true, value: header ?? fromSubprotocol};
}
