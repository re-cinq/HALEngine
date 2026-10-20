import type {ChatSession} from '../types/session.js';
import {log} from '../shared/logger.js';

/** A caller header the engine captures and may forward to tools; it narrows the three captured, never names another. */
export type ForwardableHeader = 'cookie' | 'authorization' | 'host';

type CapturedHeaders = NonNullable<ChatSession['authHeaders']>;

/** The release from which an unset `auth.forwardHeaders` forwards no header instead of all three. */
export const FORWARD_HEADERS_FLIP_VERSION = '0.10.0';

const EVERY_HEADER: readonly ForwardableHeader[] = ['cookie', 'authorization', 'host'];

// Once per process, not per engine: the setting is the same omission however many engines a process builds.
let warnedUnset = false;

/** Keeps only the allowed headers the caller sent, and `undefined` rather than `{}` when that leaves none (specs/hal-engine-tool-header-allowlist/spec.md). */
export function filterAuthHeaders(
  headers: CapturedHeaders,
  allow: readonly ForwardableHeader[]
): CapturedHeaders | undefined {
  const kept = allow.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]);
  return kept.length > 0 ? (Object.fromEntries(kept) as CapturedHeaders) : undefined;
}

/** The allowlist a capture site applies: the configured one, or all three, with a warning, while unset still means all. */
export function forwardedHeaders(configured: readonly ForwardableHeader[] | undefined): readonly ForwardableHeader[] {
  if (configured !== undefined) return configured;
  warnUnsetOnce();
  return EVERY_HEADER;
}

function warnUnsetOnce(): void {
  if (warnedUnset) return;
  warnedUnset = true;
  log.warn('auth', 'auth.forwardHeaders is unset, so every tool receives the caller cookie, authorization and host', {
    setting: 'auth.forwardHeaders',
    forwardsNoneFrom: FORWARD_HEADERS_FLIP_VERSION,
  });
}
