import {ToolRegistry} from '../orchestration/tools/registry.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {ConnectedMessage} from '../types/messages.js';
import {connectClient, startEngineWith, stopEngines} from './wsTestSupport.js';

afterEach(stopEngines);

describe('the connected frame', () => {
  it('offers no prompts to a socket opened before weather is registered and its prompt to one opened after', async () => {
    const toolRegistry = new ToolRegistry();
    const {url, hal} = await startEngineWith({sessionStore: new InMemorySessionStore(), toolRegistry});
    // Each server-side socket's close, awaited before teardown so its disconnect line lands inside the test.
    const closed: Array<Promise<void>> = [];
    hal.wss.on('connection', socket => {
      closed.push(new Promise(resolve => socket.once('close', () => setImmediate(resolve))));
    });
    // The examplePrompts of the first frame a new socket is sent, its connected frame, with the socket then closed.
    const examplePromptsOf = (): Promise<string[]> => {
      const client = connectClient(url);
      return new Promise(resolve => {
        client.once('message', raw => {
          client.close();
          resolve((JSON.parse(String(raw)) as ConnectedMessage).examplePrompts);
        });
      });
    };

    const before = await examplePromptsOf();
    toolRegistry.register(
      {
        name: 'weather',
        description: 'Reports the weather.',
        inputSchema: {type: 'object'},
        examplePrompts: ['Is it raining in Aarhus?'],
      },
      async () => 'sunny'
    );
    const after = await examplePromptsOf();
    await Promise.all(closed);

    expect({before, after}).toEqual({before: [], after: ['Is it raining in Aarhus?']});
  });
});
