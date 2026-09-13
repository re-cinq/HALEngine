import {jest} from '@jest/globals';
import type {WebSocket} from 'ws';
import {createMessageHandler} from './messageHandler.js';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {MessageChunk} from '../../types/ai.js';
import {AIError} from '../../types/ai.js';
import type {ChatSession} from '../../types/session.js';
import type {OutgoingMessage} from '../../types/messages.js';

// The frames, in order, are the contract - above all for suppression, which retracts.

// One line per frame; entries carry generated timestamps no assertion should read.
const wire = (sent: OutgoingMessage[]): string[] =>
  sent.map(frame => {
    if (frame.type === 'entry_upsert') {
      const content = 'content' in frame.entry ? frame.entry.content : '';
      return `upsert ${frame.index} ${frame.entry.role} ${JSON.stringify(content)}`;
    }
    if (frame.type === 'entry_delta') return `delta ${frame.index} ${JSON.stringify(frame.delta)}`;
    if (frame.type === 'entry_commit') return `commit ${frame.index}`;
    if (frame.type === 'entry_skip') return `skip ${frame.index}`;
    if (frame.type === 'error') return `error ${frame.code}`;
    if (frame.type === 'pong') return `pong ${frame.timestamp}`;
    return frame.type;
  });

const text = (value: string): MessageChunk => ({type: 'text', text: value});
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const SUPPRESS = {type: 'suppress_output'} as unknown as MessageChunk;

const harness = (chunks: MessageChunk[], failWith?: Error) => {
  const sent: OutgoingMessage[] = [];
  const ws = {send: (raw: string) => sent.push(JSON.parse(raw) as OutgoingMessage)} as unknown as WebSocket;

  const stream = async function* (): AsyncGenerator<MessageChunk> {
    if (failWith) throw failWith;
    for (const chunk of chunks) yield chunk;
  };

  const processMessageStream = jest.fn(stream);
  const orchestrator = {processMessageStream} as unknown as ChatOrchestrator;
  const session: ChatSession = {sessionId: 's1', userId: 'u1', entries: []};

  const handle = createMessageHandler(orchestrator);

  return {
    session,
    processMessageStream,
    frames: () => wire(sent),
    send: (raw: unknown = {type: 'user_message', content: 'hello'}) => handle(ws, session, raw),
  };
};

describe('the websocket message handler', () => {
  describe('dispatch', () => {
    it('rejects an unparseable message and never starts a stream', async () => {
      const h = harness([]);

      await h.send({type: 'nonsense'});

      const {calls} = h.processMessageStream.mock;

      expect({frames: h.frames(), streams: calls.length}).toEqual({frames: ['error INVALID_MESSAGE'], streams: 0});
    });

    it('answers a ping with the timestamp it was given', async () => {
      const h = harness([]);

      await h.send({type: 'ping', timestamp: 1234});

      expect(h.frames()).toEqual(['pong 1234']);
    });
  });

  describe('a plain assistant reply', () => {
    it('sends the user entry, then the assistant entry, its delta, its commit and stream_end', async () => {
      const h = harness([text('hi there'), STOP]);

      await h.send();

      expect(h.frames()).toEqual([
        'upsert 0 user "hello"',
        'upsert 1 assistant ""',
        'delta 1 "hi there"',
        'commit 1',
        'stream_end',
      ]);
    });

    it('leaves the committed assistant entry in the session, no longer streaming', async () => {
      const h = harness([text('hi there'), STOP]);

      await h.send();

      const {entries} = h.session;

      expect(entries[1]).toMatchObject({role: 'assistant', content: 'hi there', isStreaming: false});
    });
  });

  describe('thinking segments', () => {
    it('commits the thinking entry before the assistant entry opens', async () => {
      const h = harness([text('<thinking>pondering</thinking>answer'), STOP]);

      await h.send();

      expect(h.frames()).toEqual([
        'upsert 0 user "hello"',
        'upsert 1 thinking ""',
        'delta 1 "pondering"',
        'commit 1',
        'upsert 2 assistant ""',
        'delta 2 "answer"',
        'commit 2',
        'stream_end',
      ]);
    });

    it('commits the thinking entry when text resumes, not when a tool entry appears', async () => {
      const h = harness([
        text('<thinking>I should look up the weather for Berlin.</thinking>'),
        {type: 'tool_use', toolCall: {id: 'c1', name: 'get_weather', input: {location: 'Berlin'}}} as MessageChunk,
        text('Berlin currently has '),
        text('a temperature of 18 degrees Celsius with clear skies.'),
        STOP,
      ]);

      await h.send();

      expect(h.frames()).toEqual([
        'upsert 0 user "hello"',
        'upsert 1 thinking ""',
        'delta 1 "I should look up the weather for Berlin."',
        'upsert 2 tool ""',
        'commit 1',
        'upsert 3 assistant ""',
        'delta 3 "Berlin currently has "',
        'delta 3 "a temperature of 18 degrees Celsius with clear skies."',
        'commit 3',
        'stream_end',
      ]);
    });
  });

  describe('tool chunks', () => {
    it('sends a tool entry for a tool call', async () => {
      const h = harness([{type: 'tool_use', toolCall: {id: 'c1', name: 'lookup', input: {q: 1}}}, STOP]);

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'upsert 1 tool ""', 'stream_end']);
    });

    it('forwards a tool result to the client untouched', async () => {
      const forwarded = {type: 'entry_commit', index: 41} as OutgoingMessage;
      const h = harness([{type: 'tool_result', clientMessages: [forwarded]} as MessageChunk, STOP]);

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'commit 41', 'stream_end']);
    });
  });

  describe('suppression', () => {
    it('blanks an assistant entry that was already sent', async () => {
      const h = harness([text('leaked'), STOP, SUPPRESS]);

      await h.send();

      expect(h.frames()).toEqual([
        'upsert 0 user "hello"',
        'upsert 1 assistant ""',
        'delta 1 "leaked"',
        'commit 1',
        'upsert 1 assistant ""',
        'stream_end',
      ]);
    });

    it('never blanks a thinking entry, only assistant ones', async () => {
      const h = harness([text('<thinking>private</thinking>said'), STOP, SUPPRESS]);

      await h.send();

      expect(h.frames().filter(frame => frame.startsWith('upsert 1'))).toEqual(['upsert 1 thinking ""']);
    });

    it('skips rather than upserts a segment opened after suppression', async () => {
      const h = harness([SUPPRESS, text('hidden'), STOP]);

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'skip 1', 'stream_end']);
    });

    it('still records a suppressed reply in the session, so history keeps it', async () => {
      const h = harness([SUPPRESS, text('hidden'), STOP]);

      await h.send();

      const {entries} = h.session;

      expect(entries[1]).toMatchObject({role: 'assistant', content: 'hidden', isStreaming: false});
    });

    it('does not resurrect an entry the client only ever saw skipped', async () => {
      const h = harness([SUPPRESS, text('hidden'), STOP, SUPPRESS]);

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'skip 1', 'stream_end']);
    });

    it('blanks each sent entry once, so a second suppression repeats nothing', async () => {
      const h = harness([text('leaked'), STOP, SUPPRESS, SUPPRESS]);

      await h.send();

      expect(h.frames().filter(frame => frame === 'upsert 1 assistant ""')).toHaveLength(2);
    });
  });

  describe('failures', () => {
    it('tells the client to retry when the provider is rate limited', async () => {
      // eslint-disable-next-line re-lint/no-flag-params -- AIError's retryable flag; see adrs/ADR-006-lint-suppressions.md
      const h = harness([], new AIError('slow down', 'RATE_LIMITED', true));

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'error RATE_LIMITED']);
    });

    it('reports any other failure as a server error', async () => {
      const h = harness([], new Error('boom'));

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'error SERVER_ERROR']);
    });
  });
});
