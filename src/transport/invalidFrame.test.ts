import {once} from 'node:events';
import type {WebSocket} from 'ws';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {setLogger} from '../shared/logger.js';
import {connectClient, startEngine, stopEngines} from './wsTestSupport.js';

// Left quiet rather than restored: the server logs the socket's close after the suite has finished.
beforeAll(() => setLogger({debug() {}, info() {}, warn() {}, error() {}}));
afterEach(stopEngines);

async function nextFrame(client: WebSocket): Promise<unknown> {
  const [raw] = (await once(client, 'message')) as [Buffer];
  return JSON.parse(raw.toString());
}

it('answers a frame that is not JSON with INVALID_FORMAT and Invalid JSON, and keeps the socket open for the next frame', async () => {
  const client = connectClient(await startEngine(new InMemorySessionStore()));
  await nextFrame(client);

  client.send('{"type": "user_message", "content": ');
  const refused = await nextFrame(client);
  client.send(JSON.stringify({type: 'ping', timestamp: 1705312200000}));
  const answered = await nextFrame(client);

  expect({refused, answered}).toEqual({
    refused: {type: 'error', code: 'INVALID_FORMAT', message: 'Invalid JSON'},
    answered: {type: 'pong', timestamp: 1705312200000},
  });
});
