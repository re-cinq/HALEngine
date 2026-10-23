import {toMessages} from './conversationContext.js';
import type {SessionEntry} from '../types/session.js';

const AT = '2026-10-24T09:00:00.000Z';

it('leaves cleared entries out of the messages a turn sends the provider', () => {
  const entries: SessionEntry[] = [
    {role: 'user', content: '', timestamp: AT, cleared: true},
    {role: 'assistant', content: '', timestamp: AT, isStreaming: false, cleared: true},
    {role: 'user', content: 'Where is OLT-2026-0001?', timestamp: AT},
  ];

  expect(toMessages(entries)).toEqual([{role: 'user', content: 'Where is OLT-2026-0001?'}]);
});

it('starts at a user message of text, never at a tool result whose call the window cut away', () => {
  const entries: SessionEntry[] = [
    {role: 'user', content: '', timestamp: AT, cleared: true},
    {role: 'tool', toolName: 'lookup', toolInput: {reference: 'OLT-1'}, timestamp: AT},
    {role: 'assistant', content: 'It ships today.', timestamp: AT, isStreaming: false},
    {role: 'user', content: 'And the next one?', timestamp: AT},
  ];

  expect(toMessages(entries, {maxMessages: 3, maxContentLength: 100_000})).toEqual([
    {role: 'user', content: 'And the next one?'},
  ]);
});
