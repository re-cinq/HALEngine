import {jest} from '@jest/globals';
import {WebSocket} from 'ws';
import {ErrorCodes} from '../../types/messages.js';
import type {IncomingMessage, OutgoingMessage} from '../../types/messages.js';
import {validateMessage} from './validation.js';
import {sendJson} from './sender.js';

// The protocol takes additive changes only: the frames that shipped before a new one must still be read and sent as they were.

// Typed as the unions on purpose, so a required field added to any existing frame fails `npm run typecheck` here.
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
  it('are each still read by the validator as the frame they were, field for field', () => {
    const read = incomingBefore.map(frame => validateMessage(frame));

    expect(read).toEqual(incomingBefore.map(frame => ({valid: true, data: frame})));
  });

  it('are each still sent on the wire as the frame they were, field for field', () => {
    const ws = {send: jest.fn(), readyState: WebSocket.OPEN} as unknown as WebSocket;

    outgoingBefore.forEach(frame => sendJson(ws, frame));
    const sent = (ws.send as jest.Mock).mock.calls;

    expect(sent.map(([frame]) => JSON.parse(String(frame)))).toEqual(outgoingBefore);
  });
});
