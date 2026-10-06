// The window both stores apply, so a list cannot cost more on one than on the other.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** How many summaries one `listFor` may answer with: the caller's limit, bounded, and 50 when it names none. */
export function cappedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  // Floored rather than rejected: a fractional or negative limit is a caller's slip, not a reason to fail a list.
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}
