import {writeFileSync} from 'node:fs';
import {setLogger} from '../shared/logger.js';
import {recordFrames} from './recordFrames.js';

// `npm run record:frames` runs this, then Prettier formats what it wrote; the handlers' log lines are noise here.
setLogger({debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined});
const frames = await recordFrames();
const source = `// Written by \`npm run record:frames\` from src/testing/recordFrames.ts; edit the recorder, never this file.
import type {OutgoingMessage} from '../types/messages.js';

/** What the server sends, frame by frame, for five scripted turns; every timestamp is "<ts>" and the session id "<session-id>". */
export const recordedFrames = ${JSON.stringify(frames, null, 2)} as const satisfies Record<string, readonly OutgoingMessage[]>;
`;
writeFileSync(new URL('./frames.ts', import.meta.url), source);
