import type {AddressInfo} from 'node:net';
import {createHalEngine} from './config.js';
import {InMemorySessionStore} from './infrastructure/stores/inMemorySessionStore.js';
import type {ChatSession} from './types/session.js';
import {eventsUntilClose} from './transport/wsTestSupport.js';

// At the composition root because it drives the whole engine, which a transport test may not import.

class StoreThatCannotCreate extends InMemorySessionStore {
  override create(): ChatSession {
    throw new Error('store down');
  }
}

it('sends an error frame and closes with 1011, with no client error, through createHalEngine when the session store create throws synchronously', async () => {
  const engine = createHalEngine({
    provider: {type: 'mock'},
    prompt: {identity: 'test'},
    auth: {ws: async () => ({id: 'u1'})},
    session: new StoreThatCannotCreate(),
  });
  await engine.start(0);
  const {port} = engine.server.address() as AddressInfo;

  const events = await eventsUntilClose(`ws://127.0.0.1:${port}/hal/ws`);
  await engine.stop();

  expect(events).toEqual(['open', 'frame:error', 'close:1011']);
});
