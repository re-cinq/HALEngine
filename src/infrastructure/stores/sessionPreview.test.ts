import {labelFrom, previewOf} from './sessionPreview.js';
import type {SessionEntry} from '../../types/session.js';

// A label is derived from the conversation's opening question alone, and never from an entry the model wrote.

const AT = '2026-01-01T00:00:00.000Z';
// A surrogate half with no partner on the side a pair needs one, which is what a cut by UTF-16 unit would leave behind.
const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const asked = (content: string): SessionEntry => ({role: 'user', content, timestamp: AT});

describe('a conversation preview', () => {
  it('is the opening question, trimmed and with its internal runs of whitespace collapsed', () => {
    expect(previewOf(asked('  How   do I\n\ncancel?  '))).toBe('How do I cancel?');
  });

  it('is cut to a hundred and twenty code points, with no ellipsis of its own', () => {
    const long = previewOf(asked('x'.repeat(300)));

    expect({length: long?.length, ends: long?.endsWith('x')}).toEqual({length: 120, ends: true});
  });

  it('is cut by code point rather than by UTF-16 unit, so a pair is never halved', () => {
    const emoji = previewOf(asked('😀'.repeat(130)));

    expect({text: emoji, unpaired: UNPAIRED.test(emoji ?? '')}).toEqual({text: '😀'.repeat(120), unpaired: false});
  });

  it('is absent for a conversation that opens with an entry the model wrote, whatever that entry says', () => {
    const assistant: SessionEntry = {
      role: 'assistant',
      content: 'suppressed answer',
      timestamp: AT,
      isStreaming: false,
    };
    const thinking: SessionEntry = {role: 'thinking', content: 'pondering', isStreaming: false};
    const tool: SessionEntry = {role: 'tool', toolName: 'search', toolInput: {}, timestamp: AT};

    expect([previewOf(assistant), previewOf(thinking), previewOf(tool)]).toEqual([undefined, undefined, undefined]);
  });

  it('is absent for a conversation with no entry at all, and for one asked in whitespace alone', () => {
    expect([previewOf(undefined), previewOf(asked('   \n  '))]).toEqual([undefined, undefined]);
  });

  it('is absent for a stored entry whose text is missing or is not text, rather than failing the whole list', () => {
    const malformed = [
      {role: 'user', timestamp: AT},
      {role: 'user', content: null, timestamp: AT},
      {role: 'user', content: 42, timestamp: AT},
      null,
    ];

    expect(malformed.map(entry => previewOf(entry as unknown as SessionEntry))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('drops a joiner the cut left with nothing to join, since it is invisible in what a client renders', () => {
    const family = previewOf(asked('a'.repeat(118) + '👨‍👩‍👧'));

    expect(family?.endsWith('a👨')).toBe(true);
  });

  it('holds text a store answered with to the same bound, however long it is and whatever type it is', () => {
    const fromStore = [labelFrom('x'.repeat(5000)), labelFrom('😀'.repeat(300)), labelFrom(42), labelFrom(null)];

    expect(fromStore.map(label => (typeof label === 'string' ? [...label].length : label))).toEqual([
      120,
      120,
      undefined,
      undefined,
    ]);
  });
});
