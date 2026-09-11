import {createRequire} from 'node:module';
import {AIError} from '../types/ai.js';

const nodeRequire = createRequire(import.meta.url);

// Optional peers are absent by default, so the throw is a supported path, not a bug.
export function requireOptionalPeer<T>(specifier: string): T {
  try {
    return nodeRequire(specifier) as T;
  } catch (error) {
    if (!isModuleNotFound(error, specifier)) throw error;
    throw new AIError(
      `${specifier} is an optional peer dependency and is not installed. Run \`npm install ${specifier}\` to use this provider.`,
      'OPTIONAL_PEER_MISSING'
    );
  }
}

// Structural, not `instanceof Error`: a loader in another realm throws an Error this one disowns.
function isModuleNotFound(error: unknown, specifier: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const {code, message} = error as {code?: unknown; message?: unknown};
  if (code !== 'MODULE_NOT_FOUND' || typeof message !== 'string') return false;

  const [firstLine] = message.split('\n');

  // Only the first line names what was absent; the Require stack under it holds the peer's own files.
  return firstLine.startsWith(`Cannot find module '${specifier}'`);
}
