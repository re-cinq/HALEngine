// The window both stores apply, so a list cannot cost more on one than on the other.

import type {SessionCursor, SessionSummary} from '../../types/sessionStore.js';

const DEFAULT_LIMIT = 50;
/** The most summaries one `listFor` answers with, exported so the transport refuses a frame asking for more than the store would give. */
export const MAX_LIMIT = 200;

/** How many summaries one `listFor` may answer with: the caller's limit, bounded, and 50 when it names none. */
export function cappedLimit(limit: number | undefined): number {
  // A limit that is not a usable count reads as none given: handing a user an empty history for a typo is worse.
  if (limit === undefined || !Number.isFinite(limit) || limit < 0) return DEFAULT_LIMIT;
  // Floored rather than rejected, so only an explicit 0 answers nothing, and a fractional limit still works.
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** Newest activity first, with the larger session id ahead of the smaller on a tie, so the order is total. */
export function newestFirst(first: SessionSummary, second: SessionSummary): number {
  const gap = second.updatedAt.getTime() - first.updatedAt.getTime();
  if (gap !== 0) return gap;
  return first.sessionId < second.sessionId ? 1 : -1;
}

/** The cursor's moment, from a `Date`, an ISO string or an epoch number, so a row that went through JSON still pages. */
export function cursorAt(cursor: SessionCursor): number {
  const time = new Date(cursor.updatedAt).getTime();
  // Loudly, because every silent reading is wrong: page one again duplicates rows, and no page at all hides history.
  if (!Number.isFinite(time)) throw new Error(`listFor cursor has no usable updatedAt: ${String(cursor.updatedAt)}`);
  return time;
}

/** Whether a summary sits after the cursor in that order, which is what keeps a tie from falling between two pages. */
export function sitsAfter(summary: SessionSummary, cursorTime: number, cursorId: string): boolean {
  const gap = summary.updatedAt.getTime() - cursorTime;
  return gap < 0 || (gap === 0 && summary.sessionId < cursorId);
}
