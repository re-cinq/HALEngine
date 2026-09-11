import {WebSocket} from 'ws';
import type {SessionEntry} from '../../types/session.js';
import type {OutgoingMessage} from '../../types/messages.js';

export function sendJson(ws: WebSocket, message: OutgoingMessage): void {
  ws.send(JSON.stringify(message));
}

export function sendUpsert(ws: WebSocket, index: number, entry: SessionEntry): void {
  sendJson(ws, {type: 'entry_upsert', index, entry});
}

export function sendDelta(ws: WebSocket, index: number, delta: string): void {
  sendJson(ws, {type: 'entry_delta', index, delta});
}

export function sendCommit(ws: WebSocket, index: number): void {
  sendJson(ws, {type: 'entry_commit', index});
}

export function sendError(ws: WebSocket, code: string, message: string): void {
  sendJson(ws, {type: 'error', code, message});
}

export function sendSkip(ws: WebSocket, index: number): void {
  sendJson(ws, {type: 'entry_skip', index});
}

export function sendStreamEnd(ws: WebSocket): void {
  sendJson(ws, {type: 'stream_end'});
}
