import {WebSocket} from 'ws';
import type {OutgoingMessage} from '../../types/messages.js';

/** A socket stand-in that keeps every frame sent to it, parsed; the one send-collecting fake the handler tests and the frame recorder share. */
export interface RecordingSocket {
  /** Typed as the real socket, so it goes wherever a handler takes one; `fields` adds what an ExtWebSocket carries. */
  ws: WebSocket;
  /** Every frame sent, parsed, in order. */
  sent: OutgoingMessage[];
  /** Marks the socket closed and runs its `close` listener, as a peer that went away would. */
  close(): void;
  /** Runs its `message` listener with one raw frame, as the peer sending it would. */
  receive(frame: string): void;
}

export function recordingSocket(fields: Record<string, unknown> = {}): RecordingSocket {
  const sent: OutgoingMessage[] = [];
  const listeners = new Map<string, (arg?: unknown) => void>();
  const socket = {
    readyState: WebSocket.OPEN as number,
    send: (raw: string) => void sent.push(JSON.parse(raw) as OutgoingMessage),
    on: (event: string, listener: (arg?: unknown) => void) => void listeners.set(event, listener),
    // The connection handler pauses the socket across an awaited create and resumes it once its listeners exist.
    pause: () => undefined,
    resume: () => undefined,
    close: () => undefined,
    ...fields,
  };
  return {
    ws: socket as unknown as WebSocket,
    sent,
    close: () => {
      socket.readyState = WebSocket.CLOSED;
      listeners.get('close')?.();
    },
    receive: frame => listeners.get('message')?.(frame),
  };
}
