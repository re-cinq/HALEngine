import type {ChatSession} from '../types/session.js';

/** A caller header the engine captures and may forward to tools; it narrows the three captured, never names another. */
export type ForwardableHeader = 'cookie' | 'authorization' | 'host';

type CapturedHeaders = NonNullable<ChatSession['authHeaders']>;

/** Keeps only the allowed headers the caller sent, and `undefined` rather than `{}` when that leaves none (specs/hal-engine-tool-header-allowlist/spec.md). */
export function filterAuthHeaders(
  headers: CapturedHeaders,
  allow: readonly ForwardableHeader[]
): CapturedHeaders | undefined {
  const kept = allow.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]);
  return kept.length > 0 ? (Object.fromEntries(kept) as CapturedHeaders) : undefined;
}

/** The allowlist a capture site applies: the configured one, or none at all while it is unset. */
export function forwardedHeaders(configured: readonly ForwardableHeader[] | undefined): readonly ForwardableHeader[] {
  return configured ?? [];
}
