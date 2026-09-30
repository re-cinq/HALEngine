import {Duplex} from 'stream';

export function isValidWsPath(url: string, host: string, basePath: string): boolean {
  const pathname = new URL(url || '', `http://${host}`).pathname;
  return pathname.startsWith(`${basePath}/ws`);
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// The `sessionId` query parameter, never a path segment; anything outside the id charset reads as none.
export function sessionIdFromUpgrade(url: string, host: string, basePath: string): string | undefined {
  if (!isValidWsPath(url, host, basePath)) return undefined;
  const requested = new URL(url || '', `http://${host}`).searchParams.get('sessionId');
  return requested !== null && SESSION_ID_PATTERN.test(requested) ? requested : undefined;
}

export function rejectSocket(socket: Duplex, statusLine: string): void {
  socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
  socket.destroy();
}

export function parseWsData(frame: Buffer | string): unknown | null {
  try {
    return JSON.parse(frame.toString());
  } catch {
    return null;
  }
}
