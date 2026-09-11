import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AIError} from '../types/ai.js';
import {requireOptionalPeer} from './requireOptionalPeer.js';

// The absent-peer path is what makes an optional peer optional, so it is the contract.
const ABSENT = '@re-cinq/definitely-not-installed';

describe('requireOptionalPeer', () => {
  it('returns the installed module untouched when the peer is present', () => {
    expect(typeof requireOptionalPeer<typeof import('node:path')>('node:path').join).toBe('function');
  });

  it('throws an error naming the absent package and the command that installs it', () => {
    expect(absentPeerError()).toMatchObject({
      name: 'AIError',
      message: `${ABSENT} is an optional peer dependency and is not installed. Run \`npm install ${ABSENT}\` to use this provider.`,
    });
  });

  it('tags the absent-peer failure with OPTIONAL_PEER_MISSING rather than a raw module error', () => {
    expect(absentPeerError()).toMatchObject({code: 'OPTIONAL_PEER_MISSING'});
  });

  it('does not mark an absent peer retryable, because installing a package is not a retry', () => {
    expect(absentPeerError()).toMatchObject({retryable: false});
  });
});

// Projected to a plain object: an Error's own fields are non-enumerable, so toMatchObject skips them.
function absentPeerError(): Record<string, unknown> {
  try {
    requireOptionalPeer(ABSENT);
    return {};
  } catch (error) {
    const {name, message, code, retryable} = error as AIError;
    return {name, message, code, retryable};
  }
}

// An installed-but-broken peer is a different failure: telling the caller to install what they have wastes them.
describe('requireOptionalPeer on a module whose own dependency is missing', () => {
  let peer: string;
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'peer-'));
    peer = join(dir, 'broken-peer.cjs');
    // A real module that loads and then fails to resolve a dependency, which is what a pruned install leaves.
    writeFileSync(peer, "require('a-dependency-that-is-not-installed');\n");
  });

  afterAll(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('rethrows the loader error rather than reporting the peer itself as absent', () => {
    expect(() => requireOptionalPeer(peer)).toThrow("Cannot find module 'a-dependency-that-is-not-installed'");
  });

  it('does not dress that failure as an absent optional peer', () => {
    expect(() => requireOptionalPeer(peer)).not.toThrow(AIError);
  });
});
