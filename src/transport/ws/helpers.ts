import {Duplex} from 'stream';

export function isValidWsPath(url: string, host: string, basePath: string): boolean {
  const pathname = new URL(url || '', `http://${host}`).pathname;
  return pathname.startsWith(`${basePath}/ws`);
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
