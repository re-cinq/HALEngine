import {createEntryWriter} from './entryMutations.js';
import {setLogger} from '../shared/logger.js';
import type {AssistantEntry, ChatSession, SessionEntry, ToolEntry} from '../types/session.js';

const errors: string[] = [];
const quiet = () => undefined;
beforeEach(() => {
  errors.length = 0;
  setLogger({debug: quiet, info: quiet, warn: quiet, error: line => void errors.push(line)});
});
afterAll(() => setLogger());

const AT = '2026-10-24T09:00:00.000Z';

function sessionOf(entries: SessionEntry[] = []): ChatSession {
  return {sessionId: 's1', userId: 'u1', entries};
}

function entryAt(index: number): SessionEntry {
  const timestamp = `2026-10-24T09:00:${String(index).padStart(2, '0')}.000Z`;
  if (index % 3 === 0) return {role: 'user', content: `question ${index}`, timestamp};
  if (index % 3 === 1) return {role: 'tool', toolName: 'lookup', toolInput: {reference: `OLT-${index}`}, timestamp};
  return {role: 'assistant', content: `answer ${index}`, timestamp, isStreaming: false};
}

function visible(entry: SessionEntry): unknown {
  return entry.role === 'tool' ? entry.toolInput : entry.content;
}

function streamingAnswer(): AssistantEntry {
  return {role: 'assistant', content: '', timestamp: AT, isStreaming: true};
}

function toolCall(reference: string): ToolEntry {
  return {role: 'tool', toolName: 'lookup', toolInput: {reference}, timestamp: AT};
}

const withoutToolInput = (entry: SessionEntry): SessionEntry =>
  entry.role === 'tool' ? {...entry, toolInput: {}} : entry;

describe('createEntryWriter with no policy', () => {
  it('stores every entry as written and closes an open answer as truncated, exactly as before', () => {
    const writer = createEntryWriter();
    const session = sessionOf();
    const tool = toolCall('OLT-1');
    writer.appendEntry(session, tool);
    const index = writer.appendEntry(session, streamingAnswer());
    writer.appendDelta(session, index, 'Your booking ships today.');
    writer.closeTurn(session);

    expect({sameTool: session.entries[0] === tool, entries: session.entries}).toEqual({
      sameTool: true,
      entries: [
        tool,
        {role: 'assistant', content: 'Your booking ships today.', timestamp: AT, isStreaming: false, truncated: true},
      ],
    });
  });
});

describe('the content bound', () => {
  it('clears entries 0 to 14 and keeps 15 to 24 when a 25-entry session closes its turn with maxContentEntries 10', () => {
    const writer = createEntryWriter({maxContentEntries: 10});
    const session = sessionOf();
    for (let index = 0; index < 25; index++) writer.appendEntry(session, entryAt(index));
    writer.closeTurn(session);

    const {entries} = session;
    expect({
      length: entries.length,
      cleared: entries.flatMap((entry, index) => (entry.cleared ? [index] : [])),
      emptied: entries.slice(0, 15).map(visible),
      kept: entries.slice(15).map(visible),
    }).toEqual({
      length: 25,
      cleared: Array.from({length: 15}, (_, index) => index),
      emptied: Array.from({length: 15}, (_, index) => (index % 3 === 1 ? {} : '')),
      kept: Array.from({length: 10}, (_, offset) => visible(entryAt(offset + 15))),
    });
  });

  it('keeps every cleared entry at its index with its role and timestamp, so an index sent before the trim names the same entry', () => {
    const writer = createEntryWriter({maxContentEntries: 1});
    const session = sessionOf();
    for (let index = 0; index < 4; index++) writer.appendEntry(session, entryAt(index));
    writer.closeTurn(session);

    expect(session.entries.map(entry => ({role: entry.role, timestamp: entry.timestamp}))).toEqual(
      [0, 1, 2, 3].map(index => ({role: entryAt(index).role, timestamp: entryAt(index).timestamp}))
    );
  });

  it("keeps only the role and timestamp of a cleared entry whose role a tool invented, since its fields can't be judged", () => {
    const writer = createEntryWriter({maxContentEntries: 1});
    const card = {role: 'delivery_card', shipmentReference: 'SHP-77', timestamp: AT} as unknown as SessionEntry;
    const session = sessionOf();
    writer.appendEntry(session, card);
    writer.appendEntry(session, entryAt(0));
    writer.closeTurn(session);

    expect(session.entries[0]).toEqual({role: 'delivery_card', timestamp: AT, cleared: true});
  });

  it('clears nothing while a turn runs, since the bound applies only when the turn closes', () => {
    const writer = createEntryWriter({maxContentEntries: 1});
    const session = sessionOf([{role: 'user', content: 'question', timestamp: AT}]);
    const index = writer.appendEntry(session, streamingAnswer());
    writer.appendEntry(session, toolCall('OLT-1'));
    writer.appendDelta(session, index, 'Still answering');

    expect(session.entries.map(entry => entry.cleared ?? false)).toEqual([false, false, false]);
  });
});

describe('redactEntry', () => {
  it('rewrites a tool entry before it is stored, so the session holds no tool arguments', () => {
    const writer = createEntryWriter({redactEntry: withoutToolInput});
    const session = sessionOf();
    writer.appendEntry(session, toolCall('OLT-2026-0001'));

    expect(session.entries).toEqual([{role: 'tool', toolName: 'lookup', toolInput: {}, timestamp: AT}]);
  });

  it('sees an answer once, when it is committed, and not while it is empty and streaming', () => {
    const seen: string[] = [];
    const writer = createEntryWriter({
      redactEntry: entry => {
        if (entry.role === 'assistant') seen.push(entry.content);
        return entry.role === 'assistant' ? {...entry, content: entry.content.replace('Ada Example', '[name]')} : entry;
      },
    });
    const session = sessionOf();
    const index = writer.appendEntry(session, streamingAnswer());
    writer.appendDelta(session, index, 'Delivered to Ada Example.');
    writer.commitEntry(session, index);
    writer.closeTurn(session);

    expect({seen, stored: visible(session.entries[index])}).toEqual({
      seen: ['Delivered to Ada Example.'],
      stored: 'Delivered to [name].',
    });
  });

  it("never hands a user's own entry to redactEntry", () => {
    const roles: string[] = [];
    const writer = createEntryWriter({redactEntry: entry => (roles.push(entry.role), entry)});
    writer.appendEntry(sessionOf(), {role: 'user', content: 'Where is OLT-2026-0001?', timestamp: AT});

    expect(roles).toEqual([]);
  });

  it('stores the entry cleared and logs only its role when redactEntry returns another role', () => {
    const writer = createEntryWriter({redactEntry: entry => ({...entry, role: 'user'}) as SessionEntry});
    const session = sessionOf();
    writer.appendEntry(session, toolCall('OLT-2026-0001'));

    expect({stored: session.entries[0], logged: errors.join('\n').includes('OLT-2026-0001')}).toEqual({
      stored: {role: 'tool', toolName: 'lookup', toolInput: {}, timestamp: AT, cleared: true},
      logged: false,
    });
  });

  it('stores the entry cleared when redactEntry throws', () => {
    const writer = createEntryWriter({
      redactEntry: () => {
        throw new Error('redactor down');
      },
    });
    const session = sessionOf();
    writer.appendEntry(session, toolCall('OLT-2026-0001'));

    expect({stored: session.entries[0], loggedOnce: errors.length}).toEqual({
      stored: {role: 'tool', toolName: 'lookup', toolInput: {}, timestamp: AT, cleared: true},
      loggedOnce: 1,
    });
  });

  it('redacts an answer again when text the parser held back reaches it after the turn closed it', () => {
    const writer = createEntryWriter({
      redactEntry: entry =>
        entry.role === 'assistant' ? {...entry, content: entry.content.replaceAll('OLT-9', '[ref]')} : entry,
    });
    const session = sessionOf();
    const index = writer.appendEntry(session, streamingAnswer());
    writer.appendDelta(session, index, 'Booking ');
    writer.closeTurn(session);
    writer.appendDelta(session, index, 'OLT-9');

    expect(visible(session.entries[index])).toBe('Booking [ref]');
  });
});

describe('text arriving after the bound cleared its entry', () => {
  it('drops held-back text that reaches an answer the bound cleared when its turn closed', () => {
    const writer = createEntryWriter({maxContentEntries: 1});
    const session = sessionOf();
    const index = writer.appendEntry(session, streamingAnswer());
    writer.appendDelta(session, index, 'Booking ');
    writer.appendEntry(session, toolCall('OLT-9'));
    writer.closeTurn(session);
    writer.appendDelta(session, index, 'OLT-9 ships today');

    expect(session.entries[index]).toEqual({
      role: 'assistant',
      content: '',
      timestamp: AT,
      isStreaming: false,
      truncated: true,
      cleared: true,
    });
  });
});

describe('a policy createEntryWriter cannot honour', () => {
  it('refuses a maxContentEntries of 0, 2.5, NaN or -3, naming the setting', () => {
    const outcomes = [0, 2.5, Number.NaN, -3].map(maxContentEntries => {
      try {
        createEntryWriter({maxContentEntries});
        return 'built';
      } catch (error) {
        return (error as Error).message;
      }
    });

    expect(outcomes).toEqual(
      ['0', '2.5', 'NaN', '-3'].map(
        value => `orchestrator.entries.maxContentEntries must be a whole number of at least 1, got ${value}`
      )
    );
  });

  it('refuses a redactEntry that is not a function', () => {
    expect(() => createEntryWriter({redactEntry: 'strip' as unknown as () => SessionEntry})).toThrow(
      'orchestrator.entries.redactEntry must be a function'
    );
  });
});
