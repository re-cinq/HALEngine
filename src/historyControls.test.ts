import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {WebSocket} from 'ws';
import {createHalEngine} from './config.js';
import type {HalEngineConfig} from './config.js';
import {setLogger} from './shared/logger.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import {createMockProvider} from './providers/mock/index.js';
import {InMemorySessionStore} from './infrastructure/stores/inMemorySessionStore.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import {announcedId, connectClient, stopEngines} from './transport/wsTestSupport.js';
import type {Message, MessageChunk} from './types/ai.js';
import type {WsAuthenticator} from './types/auth.js';
import type {SessionEntry} from './types/session.js';

beforeAll(() => setLogger({debug() {}, info() {}, warn() {}, error() {}}));
afterEach(stopEngines);
afterAll(() => setLogger());

interface Frame {
  type: string;
  entry?: SessionEntry;
}

type PolicyUnderTest = Omit<HalEngineConfig, 'prompt' | 'auth' | 'session'>;

function redactBookingData(entry: SessionEntry): SessionEntry {
  if (entry.role === 'tool') return {...entry, toolInput: {}};
  if (entry.role === 'assistant') return {...entry, content: entry.content.replaceAll('Ada Example', '[name]')};
  return entry;
}

function lookupTool(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {name: 'lookup', description: 'Looks a booking up.', inputSchema: {type: 'object'}},
    async () => 'found'
  );
  return registry;
}

async function converse(config: PolicyUnderTest, questions: string[]) {
  const sessionStore = new InMemorySessionStore();
  const engine = createHalEngine({
    ...config,
    prompt: {identity: 'History controls test.'},
    session: sessionStore,
    auth: {ws: (async () => ({id: 'u1'})) as WsAuthenticator},
  });
  await engine.start(0);
  const serverSide = once(engine.wss, 'connection') as Promise<[WebSocket]>;
  const client = connectClient(`ws://127.0.0.1:${(engine.server.address() as AddressInfo).port}/hal/ws`);
  const sessionId = announcedId(client);
  const frames = await answersTo(client, questions);
  const stored = (await sessionStore.get(sessionId()))?.entries ?? [];
  const [socket] = await serverSide;
  client.close();
  await once(socket, 'close');
  await engine.stop();
  return {stored, frames};
}

function answersTo(client: WebSocket, questions: string[]): Promise<Frame[]> {
  const pending = [...questions];
  const frames: Frame[] = [];
  const ask = () => client.send(JSON.stringify({type: 'user_message', content: pending.shift()}));
  return new Promise<Frame[]>(resolve => {
    client.on('message', raw => {
      const frame = JSON.parse(String(raw)) as Frame;
      frames.push(frame);
      if (frame.type === 'connected') ask();
      if (frame.type !== 'stream_end') return;
      if (pending.length === 0) resolve(frames);
      if (pending.length > 0) ask();
    });
  });
}

it("applies orchestrator.entries to the transport's writes: a redacted tool input stored and sent, the answer redacted at commit, and older entries cleared when the turn ends", async () => {
  const {stored, frames} = await converse(
    {
      provider: {
        type: 'mock',
        turns: [
          {toolCalls: [{id: 'c1', name: 'lookup', input: {reference: 'OLT-2026-0001'}}]},
          {text: 'Delivered to Ada Example.'},
        ],
      },
      tools: lookupTool(),
      orchestrator: {entries: {maxContentEntries: 2, redactEntry: redactBookingData}},
    },
    ['Where is OLT-2026-0001?']
  );

  expect({
    stored: stored.map(({role, cleared}) => ({role, cleared: cleared ?? false})),
    toolInput: stored[1]?.role === 'tool' ? stored[1].toolInput : 'missing',
    answer: stored[2]?.role === 'assistant' ? stored[2].content : 'missing',
    toolOnWire: frames.find(frame => frame.entry?.role === 'tool')?.entry,
  }).toEqual({
    stored: [
      {role: 'user', cleared: true},
      {role: 'tool', cleared: false},
      {role: 'assistant', cleared: false},
    ],
    toolInput: {},
    answer: 'Delivered to [name].',
    toolOnWire: {role: 'tool', toolName: 'lookup', toolInput: {}, timestamp: expect.any(String)},
  });
});

it('sends the provider the redacted answer, not the streamed one, on the turn after it', async () => {
  const sent: Message[][] = [];
  await converse(
    {
      provider: {
        type: 'mock',
        turns: [{text: 'Delivered to Ada Example.'}, {text: 'You are welcome.'}],
        onSendMessage: params => void sent.push(structuredClone(params.messages)),
      },
      orchestrator: {entries: {redactEntry: redactBookingData}},
    },
    ['Where is my parcel?', 'Thanks']
  );

  expect(sent[1]).toEqual([
    {role: 'user', content: 'Where is my parcel?'},
    {role: 'assistant', content: 'Delivered to [name].'},
    {role: 'user', content: 'Thanks'},
  ]);
});

it('redacts an entry a tool returns before it is stored, and yields the stored entry for the transport to send', async () => {
  const card: SessionEntry = {
    role: 'assistant',
    content: 'Card for Ada Example',
    timestamp: '2026-10-24T09:00:00.000Z',
    isStreaming: false,
  };
  const registry = new ToolRegistry();
  registry.register({name: 'lookup', description: 'Looks a booking up.', inputSchema: {type: 'object'}}, async () => ({
    result: 'found',
    clientMessages: [{type: 'entry_upsert', index: 0, entry: card}],
  }));
  const orchestrator = createChatOrchestrator(
    createMockProvider({type: 'mock', turns: [{toolCalls: [{id: 'c1', name: 'lookup', input: {}}]}, {text: 'done'}]}),
    new PromptBuilder({identity: 'History controls test.'}),
    registry,
    {entries: {redactEntry: redactBookingData}}
  );
  const session = {
    sessionId: 's',
    userId: 'u',
    entries: [{role: 'user' as const, content: 'Where?', timestamp: '2026-10-24T09:00:00.000Z'}],
  };
  const chunks: MessageChunk[] = [];
  for await (const chunk of orchestrator.processMessageStream(session)) chunks.push(chunk);

  const redacted = {...card, content: 'Card for [name]'};
  expect({
    sent: chunks.find(chunk => chunk.type === 'tool_result'),
    stored: session.entries[1],
  }).toEqual({
    sent: {type: 'tool_result', clientMessages: [{type: 'entry_upsert', index: 1, entry: redacted}]},
    stored: redacted,
  });
});
