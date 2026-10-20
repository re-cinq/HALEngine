import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {recordedFrames} from './frames.js';
import {INTERNAL_DETAIL, recordFrames} from './recordFrames.js';
import {setLogger} from '../shared/logger.js';
import {DEFAULT_CONNECT_MESSAGE} from '../transport/ws/connectionHandler.js';

const quiet = () => undefined;
beforeAll(() => setLogger({debug: quiet, info: quiet, warn: quiet, error: quiet}));
afterAll(() => setLogger());

// One line per frame, so an assertion reads like the protocol spec's sequences.
const shapeOf = (frames: readonly {type: string; index?: number; entry?: {role: string; content?: string}}[]) =>
  frames.map(frame =>
    [frame.type, frame.index, frame.entry?.role, frame.entry?.content].filter(part => part !== undefined).join(' ')
  );

describe('recordedFrames', () => {
  it('equals a fresh recording, so a frame edited by hand fails here until npm run record:frames rewrites it', async () => {
    expect(recordedFrames).toEqual(await recordFrames());
  });

  it('records thinkingThenTool as nine frames, the commit at index 1 after the upsert at index 2', () => {
    expect(shapeOf(recordedFrames.thinkingThenTool)).toEqual([
      'entry_upsert 0 user What is the weather in Berlin?',
      'entry_upsert 1 thinking ',
      'entry_delta 1',
      'entry_upsert 2 tool',
      'entry_commit 1',
      'entry_upsert 3 assistant ',
      'entry_delta 3',
      'entry_commit 3',
      'stream_end',
    ]);
  });

  it("records multiRoundSuppressed as nine frames ending in the tool's own entry, the blanked answer and a skip", () => {
    expect(shapeOf(recordedFrames.multiRoundSuppressed).slice(-4)).toEqual([
      'entry_upsert 3 assistant 18 degrees and clear',
      'entry_upsert 1 assistant ',
      'entry_skip 4',
      'stream_end',
    ]);
  });

  it('records rateLimited ending with the RATE_LIMITED error then stream_end, carrying none of the vendor error', () => {
    expect({
      last: recordedFrames.rateLimited.slice(-2),
      leaked: JSON.stringify(recordedFrames).includes(INTERNAL_DETAIL),
    }).toEqual({
      last: [
        {type: 'error', code: 'RATE_LIMITED', message: 'AI service is busy, please try again'},
        {type: 'stream_end'},
      ],
      leaked: false,
    });
  });

  it('records connectionOpened as one connected frame, with every timestamp <ts> and the session id <session-id>', () => {
    const values = (key: string) =>
      [...JSON.stringify(recordedFrames).matchAll(new RegExp(`"${key}":"([^"]*)"`, 'g'))].map(([, value]) => value);

    expect({
      opened: recordedFrames.connectionOpened,
      timestamps: [...new Set(values('timestamp'))],
      sessionIds: [...new Set(values('sessionId'))],
    }).toEqual({
      opened: [{type: 'connected', sessionId: '<session-id>', message: DEFAULT_CONNECT_MESSAGE, examplePrompts: []}],
      timestamps: ['<ts>'],
      sessionIds: ['<session-id>'],
    });
  });

  it('is recorded from literal chunks: no file under src/testing names a provider factory', () => {
    const dir = join(process.cwd(), 'src', 'testing');
    const named = readdirSync(dir)
      .filter(name => !name.endsWith('.test.ts'))
      .filter(name =>
        /createProvider|createBedrockProvider|createVertexProvider|createMockProvider/.test(
          readFileSync(join(dir, name), 'utf8')
        )
      );

    expect(named).toEqual([]);
  });
});
