import {log} from '../shared/logger.js';
import type {EntryPolicy} from '../types/entryPolicy.js';
import type {AssistantEntry, ChatSession, SessionEntry, ThinkingEntry} from '../types/session.js';

/** Every write to a session's entries, so the entry policy cannot be skipped at a call site (specs/hal-engine-history-controls/spec.md). */
export interface EntryWriter {
  appendEntry(session: ChatSession, entry: SessionEntry): number;
  appendDelta(session: ChatSession, index: number, delta: string): void;
  markTruncated(session: ChatSession, index: number): void;
  commitEntry(session: ChatSession, index: number): void;
  /** Closes every entry still streaming, then clears what the content bound no longer keeps. */
  closeTurn(session: ChatSession): void;
}

type Redactor = EntryPolicy['redactEntry'];

export function createEntryWriter(policy: EntryPolicy = {}): EntryWriter {
  refuseUnusable(policy);
  const finalised = (entry: SessionEntry): SessionEntry => redacted(entry, policy.redactEntry);
  return {
    appendEntry(session, entry) {
      const index = session.entries.length;
      // An entry that opens streaming is final only once committed, so it is redacted then rather than empty now.
      session.entries.push(isOpen(entry) ? entry : finalised(entry));
      return index;
    },
    appendDelta(session, index, delta) {
      const entry = session.entries[index];
      if (entry.role !== 'assistant' && entry.role !== 'thinking') return;
      // Emptied by the bound once its turn closed, so text arriving later has nowhere it may be kept.
      if (entry.cleared) return;
      entry.content += delta;
      // Text the parser held back can land after the turn closed this entry, so what it adds is redacted too.
      if (!entry.isStreaming) session.entries[index] = finalised(entry);
    },
    markTruncated(session, index) {
      const entry = session.entries[index];
      if (entry.role === 'assistant' || entry.role === 'thinking') entry.truncated = true;
    },
    commitEntry(session, index) {
      const entry = session.entries[index];
      if (!isOpen(entry)) return;
      entry.isStreaming = false;
      session.entries[index] = finalised(entry);
    },
    closeTurn(session) {
      session.entries.forEach((entry, index) => {
        if (!isOpen(entry)) return;
        // Still open when the turn ended means it was cut short, which is what the transport records a moment later.
        entry.truncated = true;
        entry.isStreaming = false;
        session.entries[index] = finalised(entry);
      });
      clearBeyond(session, policy.maxContentEntries);
    },
  };
}

// Resolved once, at construction, so a policy that cannot be honoured fails before any conversation is stored.
function refuseUnusable({maxContentEntries, redactEntry}: EntryPolicy): void {
  if (maxContentEntries !== undefined && !isPositiveWhole(maxContentEntries)) {
    throw new Error(
      `orchestrator.entries.maxContentEntries must be a whole number of at least 1, got ${String(maxContentEntries)}`
    );
  }
  if (redactEntry !== undefined && typeof redactEntry !== 'function') {
    throw new Error('orchestrator.entries.redactEntry must be a function');
  }
}

function isPositiveWhole(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function isOpen(entry: SessionEntry): entry is AssistantEntry | ThinkingEntry {
  return (entry.role === 'assistant' || entry.role === 'thinking') && entry.isStreaming;
}

// A user's own words are beforeUserInput's to rewrite, so this seam leaves them alone.
function redacted(entry: SessionEntry, redact: Redactor): SessionEntry {
  if (redact === undefined || entry.role === 'user') return entry;
  const result = attempted(redact, entry);
  if (hasRole(result, entry.role)) return result;
  // The role only: the entry's content is what the policy exists to keep out of storage, logs included.
  log.error('history', 'redactEntry threw or changed the role, so the entry is stored cleared', {role: entry.role});
  return cleared(entry);
}

function attempted(redact: NonNullable<Redactor>, entry: SessionEntry): unknown {
  try {
    return redact(entry);
  } catch {
    return undefined;
  }
}

function hasRole(candidate: unknown, role: SessionEntry['role']): candidate is SessionEntry {
  return typeof candidate === 'object' && candidate !== null && (candidate as {role?: unknown}).role === role;
}

function clearBeyond(session: ChatSession, maxContentEntries: number | undefined): void {
  if (maxContentEntries === undefined) return;
  const keptFrom = session.entries.length - maxContentEntries;
  for (let index = 0; index < keptFrom; index++) {
    const entry = session.entries[index];
    if (!entry.cleared) session.entries[index] = cleared(entry);
  }
}

// Emptied in place of removed: the protocol addresses entries by index, so a removal would shift every live one.
function cleared(entry: SessionEntry): SessionEntry {
  if (entry.role === 'tool') return {...entry, toolInput: {}, cleared: true};
  if ('content' in entry && typeof entry.content === 'string') return {...entry, content: '', cleared: true};
  return roleAndTimeOnly(entry);
}

// A tool can store an entry of a role the engine does not know, whose fields it cannot judge, so only these two survive.
function roleAndTimeOnly(entry: SessionEntry): SessionEntry {
  const {role, timestamp} = entry as {role: SessionEntry['role']; timestamp?: string};
  return (timestamp === undefined ? {role, cleared: true} : {role, timestamp, cleared: true}) as SessionEntry;
}
