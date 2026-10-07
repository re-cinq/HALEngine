// The label both stores derive, so a preview cannot read differently on one than on the other.

import type {SessionEntry} from '../../types/session.js';

/** The most of an opening question a preview carries, counted in code points rather than UTF-16 units. */
const MAX_CODE_POINTS = 120;

/** A conversation's opening question as a list label, or nothing when the conversation does not open with one. */
export function previewOf(first: SessionEntry | undefined): string | undefined {
  // Only ever the user's own words: a suppressed assistant entry keeps its text here, and a list must never show it.
  if (first === undefined || first.role !== 'user') return undefined;

  const spaced = first.content.replace(/\s+/gu, ' ');
  const collapsed = spaced.trim();
  // An empty label is a row a client would render blank, which absent says honestly and `''` does not.
  if (collapsed.length === 0) return undefined;
  // Cut by code point, so a truncated emoji or a combining pair never ships as a lone surrogate.
  return [...collapsed].slice(0, MAX_CODE_POINTS).join('');
}
