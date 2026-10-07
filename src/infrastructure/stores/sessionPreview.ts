// The label both stores derive, and the bound the transport re-applies, so a preview reads the same whoever produced it.

import type {SessionEntry, UserEntry} from '../../types/session.js';

/** The most of an opening question a preview carries, counted in code points rather than UTF-16 units. */
export const MAX_CODE_POINTS = 120;
// A joiner left with nothing to join: invisible, so a client cannot style away a cut it did not make.
const DANGLING_JOINER = /‍+$/u;

/** A conversation's opening question as a list label, or nothing when the conversation does not open with one. */
export function previewOf(first: SessionEntry | undefined): string | undefined {
  // Only ever the user's own words: a suppressed assistant entry keeps its text here, and a list must never show it.
  if (!isUserEntry(first)) return undefined;
  return labelFrom(first.content);
}

/** The same label from text a store answered with rather than an entry, so the documented bound holds for any store. */
export function labelFrom(text: unknown): string | undefined {
  // A store of the consumer's own is held to the field's type at runtime, where the compiler cannot hold it.
  if (typeof text !== 'string') return undefined;

  const spaced = text.replace(/\s+/gu, ' ');
  const collapsed = spaced.trim();
  // Bounded before the spread: a code-point array of a whole transcript costs the transcript to keep 120 of it.
  const bounded = collapsed.slice(0, 2 * MAX_CODE_POINTS);
  // Cut by code point, so a truncated emoji never ships as a lone surrogate; a grapheme may still be split.
  const cut = [...bounded].slice(0, MAX_CODE_POINTS);
  const label = cut.join('').replace(DANGLING_JOINER, '');
  // An empty label is a row a client would render blank, which absent says honestly and `''` does not.
  if (label.length === 0) return undefined;
  return label;
}

// Guards the role and the text together: an entry that can lie about one can lie about the other.
function isUserEntry(entry: SessionEntry | undefined): entry is UserEntry {
  return entry !== undefined && entry !== null && entry.role === 'user';
}
