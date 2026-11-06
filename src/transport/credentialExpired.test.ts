import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {OrchestratorHooks} from '../orchestration/chatOrchestrator.js';
import type {ToolContext} from '../orchestration/tools/registry.js';
import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';
import {CredentialExpiredError} from '../types/credential.js';
import type {ChatSession} from '../types/session.js';
import {createMessageHandler} from './ws/messageHandler.js';
import {recordingSocket} from './ws/recordingSocketTestSupport.js';
import {setLogger} from '../shared/logger.js';
import {keepEveryLine} from '../shared/logCaptureTestSupport.js';
import {connectClient, startEngineWith, stopEngines} from './wsTestSupport.js';
import {whoamiOrchestrator} from './whoamiTestSupport.js';

// Consumer copy, in Danish as a deployer would write it, joined from halves so no file under src/, this one included, holds it whole.
const EXPIRED = ['Din adgang til bookingsystemet er udløbet.', 'Log ind igen for at fortsætte.'].join(' ');
const RESOLVED = 'Bearer sk-resolved-5e1f0c';

interface Run {
  frames: Array<{type: string; code?: string; message?: string}>;
  raw: string;
  contexts: ToolContext[];
}

// One turn over a real socket whose round resolves its headers through `hooks`; resolves once the server has closed too.
async function runTurn(hooks: OrchestratorHooks): Promise<Run> {
  const {orchestrator, contexts} = whoamiOrchestrator(hooks);
  const {url, hal} = await startEngineWith({sessionStore: new InMemorySessionStore(), orchestrator});
  const serverClosed = new Promise<void>(resolve => {
    hal.wss.once('connection', socket => socket.once('close', () => setImmediate(resolve)));
  });
  const client = connectClient(url);
  const raw: string[] = [];
  await new Promise<void>(resolve => {
    client.on('message', frame => {
      raw.push(String(frame));
      const {type} = JSON.parse(String(frame)) as {type: string};
      if (type === 'connected') client.send(JSON.stringify({type: 'user_message', content: 'Hvor er min pakke?'}));
      if (type === 'stream_end') resolve();
    });
  });
  client.close();
  await serverClosed;
  return {frames: raw.map(frame => JSON.parse(frame) as Run['frames'][number]), raw: raw.join('\n'), contexts};
}

// Every TypeScript file under src/, tests included, read whole.
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return entry.name.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

afterEach(stopEngines);
afterAll(() => setLogger());

describe('a credential the consumer cannot renew', () => {
  it("sends error CREDENTIAL_EXPIRED with the hook's own message, then stream_end, over a real connection", async () => {
    const {frames} = await runTurn({
      resolveAuthHeaders: async () => {
        throw new CredentialExpiredError(EXPIRED);
      },
    });

    expect(frames.slice(-2)).toEqual([
      {type: 'error', code: 'CREDENTIAL_EXPIRED', message: EXPIRED},
      {type: 'stream_end'},
    ]);
  });

  it('fires onError exactly once, with the instance the hook threw, before the error frame is sent', async () => {
    const thrown = new CredentialExpiredError(EXPIRED);
    const received: Error[] = [];
    const {ws, sent} = recordingSocket();
    let sentBeforeOnError = -1;
    const {orchestrator} = whoamiOrchestrator({
      resolveAuthHeaders: async () => {
        throw thrown;
      },
      onError: async (_session, error) => {
        received.push(error);
        sentBeforeOnError = sent.length;
      },
    });
    const session: ChatSession = {sessionId: 's1', userId: 'u1', entries: []};

    await createMessageHandler(orchestrator)(ws, session, {type: 'user_message', content: 'Hvor er min pakke?'});

    const before = sent.slice(0, sentBeforeOnError);
    expect({
      calls: received.length,
      same: received[0] === thrown,
      errorsBefore: before.filter(frame => frame.type === 'error').length,
      after: sent.slice(sentBeforeOnError).map(frame => frame.type),
    }).toEqual({calls: 1, same: true, errorsBefore: 0, after: ['error', 'stream_end']});
  });

  it('keeps the SERVER_ERROR path for any other Error the hook throws', async () => {
    const {frames} = await runTurn({
      resolveAuthHeaders: async () => {
        throw new Error('token endpoint unreachable');
      },
    });

    expect(frames.slice(-2)).toEqual([
      {type: 'error', code: 'SERVER_ERROR', message: 'Failed to process message'},
      {type: 'stream_end'},
    ]);
  });

  it('authors no product copy: the message a consumer gave appears in no file under src/, tests included', () => {
    const sources = sourcesUnder(fileURLToPath(new URL('..', import.meta.url)));

    expect({searched: sources.length > 100, found: sources.some(source => source.includes(EXPIRED))}).toEqual({
      searched: true,
      found: false,
    });
  });

  it('writes the resolved credential to no log line at any level and to no frame, though the tool received it', async () => {
    const lines = keepEveryLine();

    const {raw, contexts} = await runTurn({resolveAuthHeaders: async () => ({authorization: RESOLVED})});

    const [context] = contexts;
    expect({
      received: context?.authHeaders?.authorization,
      logged: JSON.stringify(lines).includes('sk-resolved'),
      sent: raw.includes('sk-resolved'),
    }).toEqual({received: RESOLVED, logged: false, sent: false});
  });
});
