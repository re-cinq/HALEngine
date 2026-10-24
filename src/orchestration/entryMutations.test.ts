import {trimOldContent, applyRedaction, commitStreamingEntries} from './entryMutations.js';
import type {AssistantEntry, ChatSession, ThinkingEntry, ToolEntry} from '../types/session.js';

describe('trimOldContent', () => {
  it('clears content of entries beyond the bound, keeping array length, roles and timestamps', () => {
    const session: ChatSession = {
      sessionId: 's',
      userId: 'u',
      entries: [
        {role: 'user', content: 'msg 0', timestamp: 't0'},
        {role: 'assistant', content: 'r1', timestamp: 't1', isStreaming: false},
        {role: 'user', content: 'msg 2', timestamp: 't2'},
        {role: 'assistant', content: 'r3', timestamp: 't3', isStreaming: false},
        {role: 'user', content: 'msg 4', timestamp: 't4'},
      ],
    };

    trimOldContent(session, 2);

    expect(
      session.entries.map(e => ({
        role: e.role,
        content: e.role === 'tool' ? undefined : e.content,
        timestamp: e.timestamp,
      }))
    ).toEqual([
      {role: 'user', content: '', timestamp: 't0'},
      {role: 'assistant', content: '', timestamp: 't1'},
      {role: 'user', content: '', timestamp: 't2'},
      {role: 'assistant', content: 'r3', timestamp: 't3'},
      {role: 'user', content: 'msg 4', timestamp: 't4'},
    ]);
  });
});

describe('applyRedaction', () => {
  it('stores the result of the redact transform in the session entry', () => {
    const session: ChatSession = {
      sessionId: 's',
      userId: 'u',
      entries: [{role: 'tool', toolName: 'f', toolInput: {k: 'v'}, timestamp: 't'}],
    };

    applyRedaction(session, 0, e => ({...e, toolInput: {}}));

    expect((session.entries[0] as ToolEntry).toolInput).toEqual({});
  });

  it('throws when the redact transform changes the entry role', () => {
    const session: ChatSession = {
      sessionId: 's',
      userId: 'u',
      entries: [{role: 'tool', toolName: 'f', toolInput: {}, timestamp: 't'}],
    };

    expect(() => applyRedaction(session, 0, e => ({...e, role: 'user'}))).toThrow();
  });
});

describe('commitStreamingEntries', () => {
  it('marks every streaming assistant or thinking entry as committed, and sets truncated on any still-streaming entry', () => {
    const open: AssistantEntry = {role: 'assistant', content: 'partial', timestamp: 't', isStreaming: true};
    const committed: AssistantEntry = {role: 'assistant', content: 'done', timestamp: 't', isStreaming: false};
    const thinking: ThinkingEntry = {role: 'thinking', content: 'a thought', isStreaming: true};
    const session: ChatSession = {
      sessionId: 's',
      userId: 'u',
      entries: [committed, open, thinking, {role: 'user', content: 'hello', timestamp: 't'}],
    };

    commitStreamingEntries(session);

    expect({
      committedTruncated: committed.truncated,
      openStreaming: open.isStreaming,
      openTruncated: open.truncated,
      thinkingStreaming: thinking.isStreaming,
      thinkingTruncated: thinking.truncated,
    }).toEqual({
      committedTruncated: undefined,
      openStreaming: false,
      openTruncated: true,
      thinkingStreaming: false,
      thinkingTruncated: true,
    });
  });
});
