import {createHalEngine} from '../config.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {ChatSession, SessionEntry, ToolEntry} from '../types/session.js';
import {ToolRegistry} from './tools/registry.js';
import {appendDelta} from './entryMutations.js';
import {connectClient, askOnOpen, stopEngines} from '../transport/wsTestSupport.js';

describe('HalEngineConfig history policy', () => {
  afterEach(async () => {
    await stopEngines();
  });

  it('maxContentEntries clears content but retains array slots', async () => {
    const store = new InMemorySessionStore();

    const urlId = 's1';
    const session = store.create(urlId, 'u1');
    for (let i = 0; i < 24; i++) {
      session.entries.push({
        role: 'assistant',
        content: `dummy content ${i}`,
        timestamp: '2026-01-01T00:00:00.000Z',
        isStreaming: false,
      });
    }

    const engine = createHalEngine({
      provider: {
        type: 'mock',
        turns: [{text: 'final response'}],
      },
      prompt: {identity: 'test'},
      auth: {ws: async () => ({id: 'u1'}), forwardHeaders: []},
      session: store,
      transport: {resume: {enabled: true}},
      // @ts-expect-error - history not yet typed
      history: {maxContentEntries: 10},
    });

    await engine.start(0);
    // @ts-ignore - address is an AddressInfo object
    const port = engine.server.address().port;
    const url = `ws://127.0.0.1:${port}/hal/ws/c1?sessionId=${urlId}`;

    const {client, finished} = askOnOpen(url, {until: 'stream_end', token: 't'});
    await finished;
    client.close();

    const finalSession = (await store.get(urlId)) as ChatSession;
    expect(finalSession).toBeDefined();

    // 24 dummy + 1 user + 1 assistant = 26 entries
    expect(finalSession.entries.length).toBe(26);

    for (let i = 0; i <= 15; i++) {
      expect(finalSession.entries[i].content).toBe('');
    }
    for (let i = 16; i <= 25; i++) {
      expect(finalSession.entries[i].content).not.toBe('');
    }

    const clearedEntry = finalSession.entries[0];
    expect(clearedEntry.role).toBe('assistant');
    expect(clearedEntry.timestamp).toBe('2026-01-01T00:00:00.000Z');

    appendDelta(finalSession, 0, 'new delta');
    expect(finalSession.entries[0].content).toBe('new delta');
  });

  it('redactEntry runs on ToolEntry and AssistantEntry, but not UserEntry, and rejects invalid role', async () => {
    const store = new InMemorySessionStore();

    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'test_tool',
        description: 'test',
        inputSchema: {type: 'object', properties: {arg: {type: 'string'}}},
      },
      async () => 'tool result'
    );

    const engine = createHalEngine({
      provider: {
        type: 'mock',
        turns: [
          {toolCalls: [{id: 't1', name: 'test_tool', input: {arg: 'secret'}}]},
          {text: 'assistant response with secret'},
        ],
      },
      prompt: {identity: 'test'},
      auth: {ws: async () => ({id: 'u1'}), forwardHeaders: []},
      session: store,
      tools: registry,
      transport: {resume: {enabled: true}},
      // @ts-expect-error - history not yet typed
      history: {
        redactEntry: (entry: SessionEntry) => {
          if (entry.role === 'tool') return {...entry, toolInput: {}};
          if (entry.role === 'assistant') return {...entry, content: 'redacted response'};
          if (entry.role === 'user') return {...entry, content: 'should not reach here'};
          return entry;
        },
      },
    });

    const urlId = 's2';
    store.create(urlId, 'u1');

    await engine.start(0);
    // @ts-ignore
    const port = engine.server.address().port;
    const url = `ws://127.0.0.1:${port}/hal/ws/c1?sessionId=${urlId}`;

    const {client, finished} = askOnOpen(url, {until: 'stream_end', token: 't'});
    await finished;
    client.close();

    const finalSession = (await store.get(urlId)) as ChatSession;
    expect(finalSession).toBeDefined();

    const userEntry = finalSession.entries.find(e => e.role === 'user');
    expect(userEntry!.content).toBe('hello'); // askOnOpen sends 'hello'

    const toolEntry = finalSession.entries.find(e => e.role === 'tool') as ToolEntry;
    expect(toolEntry).toBeDefined();
    expect(toolEntry.toolInput).toEqual({});

    const assistantEntry = finalSession.entries.find(e => e.role === 'assistant');
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry.content).toBe('redacted response');

    await engine.stop();

    // Rejection logic for invalid role
    const engineBad = createHalEngine({
      provider: {type: 'mock', turns: [{text: 'response'}]},
      prompt: {identity: 'test'},
      auth: {ws: async () => ({id: 'u1'}), forwardHeaders: []},
      session: store,
      transport: {resume: {enabled: true}},
      // @ts-expect-error
      history: {
        redactEntry: (entry: SessionEntry) => ({...entry, role: 'user'}),
      },
    });

    const urlIdBad = 's3';
    store.create(urlIdBad, 'u1');

    await engineBad.start(0);
    // @ts-ignore
    const portBad = engineBad.server.address().port;
    const urlBad = `ws://127.0.0.1:${portBad}/hal/ws/c1?sessionId=${urlIdBad}`;

    // Expecting the socket to close with an error because the role corruption throws
    const events: string[] = [];
    const badClient = connectClient(urlBad, 't');
    await new Promise<void>(resolve => {
      badClient.on('open', () => {
        badClient.send(JSON.stringify({type: 'user_message', content: 'hello'}));
      });
      badClient.on('message', raw => {
        const msg = JSON.parse(String(raw));
        events.push(msg.type);
      });
      badClient.on('close', () => resolve());
    });

    // The pipeline throws on invalid role, so it should send an error frame
    expect(events).toContain('error');
  });
});
