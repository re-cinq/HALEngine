import {ErrorCodes} from './messages.js';
import type {IncomingMessage, OutgoingMessage} from './messages.js';

// The protocol takes additive changes only, so every frame that compiled before a new one lands must still compile.

// Typed as the unions on purpose: a required field added to any of these stops this file compiling.
const incomingBefore: IncomingMessage[] = [
  {type: 'user_message', content: 'hello'},
  {type: 'ping', timestamp: 1},
];

const outgoingBefore: OutgoingMessage[] = [
  {type: 'connected', sessionId: 's1', message: 'Connected', examplePrompts: []},
  {type: 'entry_upsert', index: 0, entry: {role: 'user', content: 'hello', timestamp: 'now'}},
  {type: 'entry_delta', index: 0, delta: 'hi'},
  {type: 'entry_commit', index: 0},
  {type: 'entry_skip', index: 0},
  {type: 'error', code: ErrorCodes.SERVER_ERROR, message: 'broke'},
  {type: 'pong', timestamp: 1},
  {type: 'stream_end'},
];

describe('the frames that shipped before the conversation list', () => {
  it('still satisfy the protocol unions, every one of them, with no field they did not carry', () => {
    expect({
      incoming: incomingBefore.map(frame => frame.type),
      outgoing: outgoingBefore.map(frame => frame.type),
    }).toEqual({
      incoming: ['user_message', 'ping'],
      outgoing: [
        'connected',
        'entry_upsert',
        'entry_delta',
        'entry_commit',
        'entry_skip',
        'error',
        'pong',
        'stream_end',
      ],
    });
  });

  it('leaves a connected frame compiling with none of the fields resume and history added', () => {
    const minimal: OutgoingMessage = {type: 'connected', sessionId: 's1', message: 'Connected', examplePrompts: []};

    expect('resumed' in minimal || 'entryCount' in minimal || 'resumeFailure' in minimal).toBe(false);
  });
});
