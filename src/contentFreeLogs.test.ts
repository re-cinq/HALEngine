import {jest} from '@jest/globals';
import type {AddressInfo} from 'node:net';

// The level is read once, when the logger loads, so it is set before anything first-party is imported.
process.env.LOG_LEVEL = 'debug';
const {createHalEngine} = await import('./config.js');
const {ToolRegistry} = await import('./orchestration/tools/registry.js');
const {InMemorySessionStore} = await import('./infrastructure/stores/inMemorySessionStore.js');
const {connectClient, framesUntil} = await import('./transport/wsTestSupport.js');

const QUESTION = 'Where is parcel ZX-4471 heading?';
const TOOL_ARGUMENT = 'QK-9083';
const TOOL_RESULT = 'Held at the Aarhus depot';
const ANSWER = 'It reaches Odense on Friday.';

interface Line {
  severity: string;
  data?: {contentLength?: number};
}

async function oneTurnLogged(): Promise<string[]> {
  const lines: string[] = [];
  const keep = (raw: unknown) => void lines.push(String(raw));
  jest.spyOn(console, 'log').mockImplementation(keep);
  jest.spyOn(console, 'error').mockImplementation(keep);
  const engine = createHalEngine({
    prompt: {identity: 'Log content test.'},
    session: new InMemorySessionStore(),
    auth: {ws: async () => ({id: 'u1'})},
    provider: {
      type: 'mock',
      turns: [{toolCalls: [{id: 'c1', name: 'lookup', input: {reference: TOOL_ARGUMENT}}]}, {text: ANSWER}],
    },
    tools: lookupTool(),
  });
  await engine.start(0);
  const {port} = engine.server.address() as AddressInfo;
  const client = connectClient(`ws://127.0.0.1:${port}/hal/ws`);
  const ended = framesUntil(client, 'stream_end');
  const socketClosed = new Promise<void>(resolve =>
    engine.wss.once('connection', socket => socket.once('close', () => resolve()))
  );
  client.on('open', () => client.send(JSON.stringify({type: 'user_message', content: QUESTION})));
  await ended;
  await engine.stop();
  await socketClosed;
  return lines;
}

function lookupTool() {
  const registry = new ToolRegistry();
  registry.register(
    {name: 'lookup', description: 'Looks a parcel up.', inputSchema: {type: 'object'}},
    async () => TOOL_RESULT
  );
  return registry;
}

it('logs a 32-character question as contentLength 32 at debug level, and no line carries the question, a tool argument or result, or the answer', async () => {
  const lines = await oneTurnLogged();

  const parsed = lines.map(line => JSON.parse(line) as Line);
  expect({
    debugLogged: parsed.some(line => line.severity === 'DEBUG'),
    contentLength: parsed.find(line => line.data?.contentLength !== undefined)?.data,
    leaked: [QUESTION, TOOL_ARGUMENT, TOOL_RESULT, ANSWER].filter(text => lines.some(line => line.includes(text))),
  }).toMatchObject({debugLogged: true, contentLength: {contentLength: 32}, leaked: []});
});
