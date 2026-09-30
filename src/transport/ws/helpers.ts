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
