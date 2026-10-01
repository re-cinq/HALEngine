import {Duplex} from 'stream';

export function isValidWsPath(url: string, basePath: string): boolean {
  return targetOf(url)?.pathname.startsWith(`${basePath}/ws`) ?? false;
}

// Against a fixed base, since the host plays no part in the path or query; a target that is not a URL reads as none.
function targetOf(url: string): URL | undefined {
  try {
    return new URL(url || '', 'http://localhost');
  } catch {
    return undefined;
  }
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// The `sessionId` query parameter, never a path segment; anything outside the id charset reads as none.
export function sessionIdFromUpgrade(url: string, basePath: string): string | undefined {
  if (!isValidWsPath(url, basePath)) return undefined;
  const requested = targetOf(url)?.searchParams.get('sessionId');
  return typeof requested === 'string' && SESSION_ID_PATTERN.test(requested) ? requested : undefined;
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
