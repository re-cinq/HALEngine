import type {SessionEntry, ChatSession} from '../types/session.js';

export function appendEntry(session: ChatSession, entry: SessionEntry): number {
  const index = session.entries.length;
  session.entries.push(entry);
  return index;
}

export function appendDelta(session: ChatSession, index: number, delta: string): void {
  const entry = session.entries[index];
  if (entry.role === 'assistant' || entry.role === 'thinking') {
    entry.content += delta;
  }
}

export function markTruncated(session: ChatSession, index: number): void {
  const entry = session.entries[index];
  if (entry.role === 'assistant' || entry.role === 'thinking') {
    entry.truncated = true;
  }
}

export function commitEntry(session: ChatSession, index: number): void {
  const entry = session.entries[index];
  if (entry.role === 'assistant' || entry.role === 'thinking') {
    entry.isStreaming = false;
  }
}

export function trimOldContent(session: ChatSession, maxContentEntries: number): void {
  const clearCount = session.entries.length - maxContentEntries;
  if (clearCount <= 0) return;
  for (let i = 0; i < clearCount; i++) {
    const entry = session.entries[i];
    if (entry.role === 'tool') {
      entry.toolInput = {};
    } else {
      entry.content = '';
    }
  }
}

export function applyRedaction(
  session: ChatSession,
  index: number,
  redactEntry: (entry: SessionEntry) => {role: SessionEntry['role']}
): void {
  const entry = session.entries[index];
  const redacted = redactEntry(entry);
  if (redacted.role !== entry.role) {
    throw new Error(
      `redactEntry must not change entry role: returned '${String(redacted.role)}', expected '${entry.role}'`
    );
  }
  session.entries[index] = redacted as SessionEntry;
}

// A turn ends with its entries closed however it ended, so nothing persists an entry still marked streaming.
export function commitStreamingEntries(session: ChatSession): void {
  for (const entry of session.entries) {
    if (entry.role !== 'assistant' && entry.role !== 'thinking') continue;
    // Still open when the turn ended means it was cut short, which is what the transport records a moment later.
    if (entry.isStreaming) entry.truncated = true;
    entry.isStreaming = false;
  }
}
