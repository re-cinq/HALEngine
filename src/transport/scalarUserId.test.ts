import {WebSocket} from 'ws';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import type {WsAuthenticator} from '../types/auth.js';
import {setLogger} from '../shared/logger.js';
import {HAL_WS_SUBPROTOCOL} from './ws/subprotocol.js';
import {startEngineWith, stopEngines} from './wsTestSupport.js';

// Real upgrades: the id a wsAuth resolves is refused at the door, before any store sees it.

const lines: string[] = [];
const collect = (category: string, message: string, fields?: Record<string, unknown>) =>
  void lines.push(JSON.stringify({category, message, fields}));
beforeEach(() => {
  lines.length = 0;
  setLogger({debug: collect, info: collect, warn: collect, error: collect});
});
afterEach(() => stopEngines());
afterAll(() => setLogger());

// What a client sees of one upgrade: the refusing status, or `open` for a 101.
const upgradeAs = async (id: unknown, sessionStore = new InMemorySessionStore()) => {
  const wsAuth: WsAuthenticator = async () => ({id: id as string});
  const {url} = await startEngineWith({sessionStore, wsAuth});
  const answer = await new Promise<string>(resolve => {
    const client = new WebSocket(url, [HAL_WS_SUBPROTOCOL]);
    // Terminating a refused handshake reports an error the refusal already answered.
    client.on('error', () => undefined);
    client.once('unexpected-response', (_request, response) => {
      client.terminate();
      resolve(String(response.statusCode));
    });
    client.once('open', () => {
      client.close();
      resolve('open');
    });
  });
  return {answer, held: sessionStore.count()};
};

describe('an authenticated id the engine cannot use as an identity', () => {
  it('answers 401 to a wsAuth resolving {id: {$ne: null}}, and creates no session', async () => {
    expect(await upgradeAs({$ne: null})).toEqual({answer: '401', held: 0});
  });

  it('answers 401 for undefined, null, an array, NaN and Infinity, while a string and a finite number connect', async () => {
    const outcomes = [];
    for (const id of [undefined, null, [], Number.NaN, Number.POSITIVE_INFINITY, 'u1', 42]) {
      outcomes.push(await upgradeAs(id));
    }

    expect(outcomes.map(({answer, held}) => `${answer} held ${held}`)).toEqual([
      '401 held 0',
      '401 held 0',
      '401 held 0',
      '401 held 0',
      '401 held 0',
      'open held 1',
      'open held 1',
    ]);
  });

  it("logs the refusal at error with the id's kind and none of its contents", async () => {
    await upgradeAs({$ne: null, marker: 'needle-55'});

    const refusal = lines.filter(line => line.includes('a user id the engine cannot use'));
    expect({refusal, leaked: /needle-55|\$ne/.test(lines.join('\n'))}).toEqual({
      refusal: [
        JSON.stringify({
          category: 'ws',
          message: 'authenticator returned a user id the engine cannot use',
          fields: {idKind: 'object'},
        }),
      ],
      leaked: false,
    });
  });

  it("never reaches listFor for a socket authenticated as {$ne: null} against a store holding two other users' conversations", async () => {
    const store = new InMemorySessionStore();
    store.create('a', 'alice');
    store.create('b', 'bob');
    const listed: unknown[] = [];
    const listFor = store.listFor.bind(store);
    store.listFor = (userId, options) => {
      listed.push(userId);
      return listFor(userId, options);
    };

    const {answer} = await upgradeAs({$ne: null}, store);

    expect({answer, listed, held: store.count()}).toEqual({answer: '401', listed: [], held: 2});
  });
});
