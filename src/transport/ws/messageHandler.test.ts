import {jest} from '@jest/globals';
import type {WebSocket} from 'ws';
import {createMessageHandler} from './messageHandler.js';
import {TOOL_BUDGET_EXHAUSTED} from '../../orchestration/chatOrchestrator.js';
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

interface StreamScript {
  failWith?: Error;
  pauseAfter?: {chunks: number; until: Promise<void>};
}

const deferred = () => {
  let release = (): void => undefined;
  const until = new Promise<void>(resolve => {
    release = resolve;
  });
  return {until, release};
};

const harness = (chunks: MessageChunk[], {failWith, pauseAfter}: StreamScript = {}) => {
  const sent: OutgoingMessage[] = [];
  const ws = {send: (raw: string) => sent.push(JSON.parse(raw) as OutgoingMessage)} as unknown as WebSocket;

  const stream = async function* (): AsyncGenerator<MessageChunk> {
    for (const [position, chunk] of chunks.entries()) {
      if (pauseAfter && position === pauseAfter.chunks) await pauseAfter.until;
      yield chunk;
    }
    if (failWith) throw failWith;
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
      const h = harness([], {failWith: new AIError('slow down', 'RATE_LIMITED', true)});

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'error RATE_LIMITED', 'stream_end']);
    });

    it('reports any other failure as a server error', async () => {
      const h = harness([], {failWith: new Error('boom')});

      await h.send();

      expect(h.frames()).toEqual(['upsert 0 user "hello"', 'error SERVER_ERROR', 'stream_end']);
    });
  });

  describe('the terminal frame', () => {
    it('ends a provider failure mid-stream with error then stream_end, stream_end last', async () => {
      const h = harness([text('Half an ans')], {failWith: new Error('provider dropped')});

      await h.send();

      expect(h.frames()).toEqual([
        'upsert 0 user "hello"',
        'upsert 1 assistant ""',
        'delta 1 "Half an ans"',
        'commit 1',
        'error SERVER_ERROR',
        'stream_end',
      ]);
    });

    const invalidRun = async (content: string) => {
      const h = harness([]);
      await h.send({type: 'user_message', content});
      const {calls} = h.processMessageStream.mock;
      return {frames: h.frames(), streams: calls.length};
    };
    const REFUSED = {frames: ['error INVALID_MESSAGE', 'stream_end'], streams: 0};

    it('answers an empty user_message with INVALID_MESSAGE then stream_end', async () => {
      expect(await invalidRun('')).toEqual(REFUSED);
    });

    it('answers a blank user_message with INVALID_MESSAGE then stream_end', async () => {
      expect(await invalidRun('   ')).toEqual(REFUSED);
    });

    it('answers an over-length user_message with INVALID_MESSAGE then stream_end', async () => {
      expect(await invalidRun('x'.repeat(10_001))).toEqual(REFUSED);
    });

    it('answers a malformed ping with INVALID_MESSAGE and no stream_end', async () => {
      const h = harness([]);

      await h.send({type: 'ping', timestamp: 'soon'});

      expect(h.frames()).toEqual(['error INVALID_MESSAGE']);
    });

    it('keeps one stream_end, last, when a malformed ping lands mid-run', async () => {
      const gate = deferred();
      const h = harness([text('first '), text('second'), STOP], {pauseAfter: {chunks: 1, until: gate.until}});

      const run = h.send();
      await new Promise(resolve => setImmediate(resolve));
      await h.send({type: 'ping', timestamp: 'soon'});
      gate.release();
      await run;

      expect(h.frames()).toEqual([
        'upsert 0 user "hello"',
        'upsert 1 assistant ""',
        'delta 1 "first "',
        'error INVALID_MESSAGE',
        'delta 1 "second"',
        'commit 1',
        'stream_end',
      ]);
    });

    it('sends one stream_end for a three-round tool conversation', async () => {
      const call = (id: string): MessageChunk => ({type: 'tool_use', toolCall: {id, name: 'lookup', input: {id}}});
      const h = harness([call('c1'), call('c2'), call('c3'), text('Done'), STOP]);

      await h.send();

      const frames = h.frames();
      expect({ends: frames.filter(frame => frame === 'stream_end').length, last: frames.at(-1)}).toEqual({
        ends: 1,
        last: 'stream_end',
      });
    });
  });

  describe('open entries on every terminal path', () => {
    const stillStreaming = ({entries}: ChatSession): number =>
      entries.filter(entry => 'isStreaming' in entry && entry.isStreaming).length;
    const DROPPED = new Error('provider dropped');

    it('commits a partial answer as streamed, before the error, when the provider throws', async () => {
      const h = harness([text('partial answer')], {failWith: DROPPED});

      await h.send();

      const [, answer] = h.session.entries;
      expect({frames: h.frames(), open: stillStreaming(h.session), answer}).toMatchObject({
        frames: [
          'upsert 0 user "hello"',
          'upsert 1 assistant ""',
          'delta 1 "partial answer"',
          'commit 1',
          'error SERVER_ERROR',
          'stream_end',
        ],
        open: 0,
        answer: {role: 'assistant', content: 'partial answer', isStreaming: false},
      });
    });

    it('commits an open thinking entry too when the provider throws mid-thought', async () => {
      const h = harness([text('<thinking>half a thou')], {failWith: DROPPED});

      await h.send();

      expect({
        commits: h.frames().filter(frame => frame.startsWith('commit')),
        open: stillStreaming(h.session),
      }).toEqual({
        commits: ['commit 1'],
        open: 0,
      });
    });

    it('commits the answer when a round ends on a tool call with no stop chunk', async () => {
      const lookup: MessageChunk = {type: 'tool_use', toolCall: {id: 'c1', name: 'lookup', input: {}}};
      const h = harness([text('Let me check'), lookup]);

      await h.send();

      expect({last: h.frames().slice(-2), open: stillStreaming(h.session)}).toEqual({
        last: ['commit 1', 'stream_end'],
        open: 0,
      });
    });

    it('sends one commit per opened entry when the turn ends on a stop chunk', async () => {
      const h = harness([text('<thinking>pondering</thinking>answer'), STOP]);

      await h.send();

      expect(h.frames().filter(frame => frame.startsWith('commit'))).toEqual(['commit 1', 'commit 2']);
    });

    it('records the open entries under suppression without sending a commit when the provider throws', async () => {
      const h = harness([SUPPRESS, text('hidden')], {failWith: DROPPED});

      await h.send();

      expect({frames: h.frames(), open: stillStreaming(h.session)}).toEqual({
        frames: ['upsert 0 user "hello"', 'skip 1', 'error SERVER_ERROR', 'stream_end'],
        open: 0,
      });
    });
  });

  describe('an exhausted tool budget', () => {
    const SENTENCE = 'A colleague will follow up on this.';
    const LOOKUP: MessageChunk = {type: 'tool_use', toolCall: {id: 'c1', name: 'lookup', input: {}}};
    const TOOL_STOP: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
    const BUDGET_STOP: MessageChunk = {type: 'stop', stopReason: TOOL_BUDGET_EXHAUSTED};

    it("renders the hook's sentence as its own committed entry, then stream_end, with no error", async () => {
      const h = harness([LOOKUP, TOOL_STOP, text(SENTENCE), BUDGET_STOP]);

      await h.send();

      const frames = h.frames();
      expect({tail: frames.slice(-4), errors: frames.filter(frame => frame.startsWith('error'))}).toEqual({
        tail: ['upsert 2 assistant ""', `delta 2 ${JSON.stringify(SENTENCE)}`, 'commit 2', 'stream_end'],
        errors: [],
      });
    });

    it('writes the sentence into the session but only skips it on the wire under suppression', async () => {
      const h = harness([LOOKUP, TOOL_STOP, SUPPRESS, text(SENTENCE), BUDGET_STOP]);

      await h.send();

      const frames = h.frames();
      const [, , stored] = h.session.entries;
      expect({
        skipped: frames.includes('skip 2'),
        deltas: frames.filter(frame => frame.startsWith('delta 2')),
        stored,
      }).toMatchObject({skipped: true, deltas: [], stored: {role: 'assistant', content: SENTENCE}});
    });
  });
});
