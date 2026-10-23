import {trimOldContent} from './entryMutations.js';
import type {ChatSession} from '../types/session.js';

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
