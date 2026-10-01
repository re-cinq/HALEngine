import {Duplex} from 'stream';

export function isValidWsPath(url: string, basePath: string): boolean {
  return pathnameOf(url)?.startsWith(`${basePath}/ws`) ?? false;
}

// Against a fixed base, since the host plays no part in the path; a target that is not a URL reads as no path at all.
function pathnameOf(url: string): string | undefined {
  try {
    return new URL(url || '', 'http://localhost').pathname;
  } catch {
    return undefined;
  }
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
