import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import type {Express} from 'express';
import {createServer} from './createServer.js';
import {HAL_WS_SUBPROTOCOL} from './ws/subprotocol.js';
import type {ChatOrchestrator} from '../orchestration/chatOrchestrator.js';
import type {MessageChunk} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';
import type {SessionStore} from '../types/sessionStore.js';

// Shared by the suites that need a real upgrade over a real socket, which no double can stand in for.

const servers: Array<{stop: () => Promise<void>}> = [];
const clients: WebSocket[] = [];

/** An orchestrator that answers once and stops, which is what commits the turn's assistant entry. */
export const answeringOrchestrator: ChatOrchestrator = {
  processMessage: async () => 'hi',
  async *processMessageStream(): AsyncGenerator<MessageChunk> {
    yield {type: 'text', text: 'hi'};
    yield {type: 'stop', stopReason: 'end_turn'};
  },
};

/** Starts an engine on an ephemeral port and returns the URL a client should open. */
export async function startEngine(
  sessionStore: SessionStore,
  onDisconnect?: (sessionId: string) => void
): Promise<string> {
  const hal = createServer({
    app: (() => undefined) as unknown as Express,
    wsAuth: async () => ({id: 'u1'}),
    sessionStore,
    orchestrator: answeringOrchestrator,
    onDisconnect,
  });
  await hal.start(0);
  servers.push(hal);
  const {port} = hal.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/hal/ws/c1`;
}

/** Opens a client that the suite's teardown will close, whether its test passed or failed. */
export function connectClient(url: string): WebSocket {
  const client = new WebSocket(url, [HAL_WS_SUBPROTOCOL, 't']);
  clients.push(client);
  return client;
}

/** Resolves with every frame type seen up to and including the first `until` frame. */
export function framesUntil(client: WebSocket, until: string): Promise<string[]> {
  const seen: string[] = [];
  return new Promise<string[]>(resolve => {
    client.on('message', raw => {
      const {type} = JSON.parse(String(raw)) as {type: string};
      seen.push(type);
      if (type === until) resolve(seen);
    });
  });
}

/** Opens a client that asks one question the moment the socket opens, resolving on its `stream_end`. */
export function askOnOpen(url: string): {client: WebSocket; finished: Promise<string[]>} {
  const client = connectClient(url);
  const finished = framesUntil(client, 'stream_end');
  client.on('open', () => client.send(JSON.stringify({type: 'user_message', content: 'hello'})));
  return {client, finished};
}

/** Tears every socket and server down, so a red test reports instead of hanging the run. */
export async function stopEngines(): Promise<void> {
  for (const client of clients.splice(0)) client.terminate();
  for (const hal of servers.splice(0)) await hal.stop();
}

/** The one session a store holds, for asserting what survived a close. */
export async function onlySession(store: SessionStore, sessionId: string): Promise<ChatSession | undefined> {
  return (await store.get(sessionId)) as ChatSession | undefined;
}
