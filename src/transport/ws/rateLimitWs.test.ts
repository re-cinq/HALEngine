import {jest} from '@jest/globals';
import {createMessageHandler} from './messageHandler.js';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import {InMemorySessionStore} from '../../infrastructure/stores/inMemorySessionStore.js';
import type {MessageChunk} from '../../types/ai.js';
import type {OutgoingMessage} from '../../types/messages.js';
import type {ChatSession} from '../../types/session.js';
import {createRateLimiter} from '../rateLimit.js';
import {deferred} from '../wsTestSupport.js';
import {recordingSocket} from './recordingSocketTestSupport.js';
import {setLogger} from '../../shared/logger.js';

// specs/hal-engine-rate-limit

const USER_MESSAGE = {type: 'user_message', content: 'hej'};
const PING = {type: 'ping', timestamp: 1};
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const FROZEN_CLOCK = () => 0;
const REFUSED = 'error TOO_MANY_REQUESTS 3000';

interface HarnessOptions {
  burst?: number;
  holdUntil?: Promise<void>;
  limiter?: false;
}

const shape = (sent: OutgoingMessage[]): string[] =>
  sent.map(frame => (frame.type === 'error' ? `error ${frame.code} ${frame.retryAfterMs}` : frame.type));

const count = (sent: OutgoingMessage[], type: OutgoingMessage['type']): number =>
  sent.filter(frame => frame.type === type).length;

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

const sessionOf = (sessionId: string): ChatSession => ({sessionId, userId: 'u1', entries: []});

function harness({burst = 5, holdUntil, limiter}: HarnessOptions = {}) {
  const {ws, sent} = recordingSocket();
  let runs = 0;
  const stream = async function* (): AsyncGenerator<MessageChunk> {
    runs += 1;
    if (holdUntil) await holdUntil;
    yield {type: 'text', text: 'ok'};
    yield STOP;
  };
  const orchestrator = {processMessageStream: jest.fn(stream)} as unknown as ChatOrchestrator;
  const rateLimiter = limiter === false ? undefined : createRateLimiter({burst}, FROZEN_CLOCK);
  const handle = createMessageHandler(orchestrator, {sessionStore: new InMemorySessionStore(), rateLimiter});
  return {ws, sent, handle, runs: () => runs, session: sessionOf('s1')};
}

async function sendTimes(parts: ReturnType<typeof harness>, frame: object, times: number, session = parts.session) {
  for (let index = 0; index < times; index += 1) await parts.handle(parts.ws, session, frame);
}

describe('the WebSocket user_message gate', () => {
  it('refuses the sixth user_message of user u1 in a row with one error TOO_MANY_REQUESTS carrying retryAfterMs 3000 and a stream_end, running no sixth turn', async () => {
    const parts = harness();

    await sendTimes(parts, USER_MESSAGE, 6);

    expect({
      runs: parts.runs(),
      errors: shape(parts.sent).filter(frame => frame.startsWith('error')),
      tail: shape(parts.sent).slice(-3),
    }).toEqual({runs: 5, errors: [REFUSED], tail: ['stream_end', REFUSED, 'stream_end']});
  });

  it('counts no ping: ten pings between a user_message and the next still leave that next one allowed at burst 11', async () => {
    const parts = harness({burst: 11});

    await sendTimes(parts, USER_MESSAGE, 1);
    await sendTimes(parts, PING, 10);
    await sendTimes(parts, USER_MESSAGE, 1);

    expect({
      pongs: count(parts.sent, 'pong'),
      runs: parts.runs(),
      errors: count(parts.sent, 'error'),
    }).toEqual({pongs: 10, runs: 2, errors: 0});
  });

  it("draws two sessions of user u1 on one bucket: three messages on s1 and two on s2 are allowed, s2's third is refused", async () => {
    const parts = harness();
    const second = sessionOf('s2');

    await sendTimes(parts, USER_MESSAGE, 3);
    await sendTimes(parts, USER_MESSAGE, 3, second);

    expect({
      runs: parts.runs(),
      errors: shape(parts.sent).filter(frame => frame.startsWith('error')),
    }).toEqual({runs: 5, errors: [REFUSED]});
  });

  it('refuses nothing without a limiter: thirty user_messages in a row all run', async () => {
    const parts = harness({limiter: false});

    await sendTimes(parts, USER_MESSAGE, 30);

    expect({
      runs: parts.runs(),
      errors: count(parts.sent, 'error'),
    }).toEqual({runs: 30, errors: 0});
  });

  it("queues a refusal behind the session's earlier turn, so its error and stream_end follow that answer's stream_end", async () => {
    const hold = deferred();
    const parts = harness({burst: 1, holdUntil: hold.until});

    const first = parts.handle(parts.ws, parts.session, USER_MESSAGE);
    const second = parts.handle(parts.ws, parts.session, USER_MESSAGE);
    await nextTick();
    const whileHeld = shape(parts.sent);
    hold.release();
    await Promise.all([first, second]);

    expect({whileHeld, tail: shape(parts.sent).slice(-3)}).toEqual({
      whileHeld: ['entry_upsert'],
      tail: ['stream_end', REFUSED, 'stream_end'],
    });
  });

  it('logs a refusal with sessionId and retryAfterMs alone: neither the message content nor the authorization header reaches any log line', async () => {
    const lines: Array<{level: string; fields?: Record<string, unknown>}> = [];
    const into = (level: string) => (_category: string, _message: string, fields?: Record<string, unknown>) =>
      void lines.push({level, fields});
    setLogger({debug: into('debug'), info: into('info'), warn: into('warn'), error: into('error')});
    const parts = harness({burst: 1});
    const session: ChatSession = {...sessionOf('s1'), authHeaders: {authorization: 'Bearer secret-token-4711'}};
    const content = 'Min booking OLT-2026-0001 er forsinket';

    await parts.handle(parts.ws, session, {type: 'user_message', content});
    await parts.handle(parts.ws, session, {type: 'user_message', content});
    setLogger();

    expect({
      refusal: lines.filter(line => line.level === 'warn').map(line => line.fields),
      leaked: JSON.stringify(lines).includes('secret-token-4711') || JSON.stringify(lines).includes(content),
    }).toEqual({refusal: [{sessionId: 's1', retryAfterMs: 3000}], leaked: false});
  });
});
