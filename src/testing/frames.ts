// Written by `npm run record:frames` from src/testing/recordFrames.ts; edit the recorder, never this file.
import type {OutgoingMessage} from '../types/messages.js';

/** What the server sends, frame by frame, for five scripted turns; every timestamp is "<ts>" and the session id "<session-id>". */
export const recordedFrames = {
  connectionOpened: [
    {
      type: 'connected',
      sessionId: '<session-id>',
      message: 'Connected to HAL Engine',
      examplePrompts: [],
    },
  ],
  simpleAnswer: [
    {
      type: 'entry_upsert',
      index: 0,
      entry: {
        role: 'user',
        content: 'What is the weather in Berlin?',
        timestamp: '<ts>',
      },
    },
    {
      type: 'entry_upsert',
      index: 1,
      entry: {
        role: 'assistant',
        content: '',
        timestamp: '<ts>',
        isStreaming: true,
      },
    },
    {
      type: 'entry_delta',
      index: 1,
      delta: '18 degrees and clear',
    },
    {
      type: 'entry_commit',
      index: 1,
    },
    {
      type: 'stream_end',
    },
  ],
  thinkingThenTool: [
    {
      type: 'entry_upsert',
      index: 0,
      entry: {
        role: 'user',
        content: 'What is the weather in Berlin?',
        timestamp: '<ts>',
      },
    },
    {
      type: 'entry_upsert',
      index: 1,
      entry: {
        role: 'thinking',
        content: '',
        isStreaming: true,
      },
    },
    {
      type: 'entry_delta',
      index: 1,
      delta: 'Berlin',
    },
    {
      type: 'entry_upsert',
      index: 2,
      entry: {
        role: 'tool',
        toolName: 'weather',
        toolInput: {
          city: 'Berlin',
        },
        timestamp: '<ts>',
      },
    },
    {
      type: 'entry_commit',
      index: 1,
    },
    {
      type: 'entry_upsert',
      index: 3,
      entry: {
        role: 'assistant',
        content: '',
        timestamp: '<ts>',
        isStreaming: true,
      },
    },
    {
      type: 'entry_delta',
      index: 3,
      delta: '18 degrees and clear',
    },
    {
      type: 'entry_commit',
      index: 3,
    },
    {
      type: 'stream_end',
    },
  ],
  multiRoundSuppressed: [
    {
      type: 'entry_upsert',
      index: 0,
      entry: {
        role: 'user',
        content: 'What is the weather in Berlin?',
        timestamp: '<ts>',
      },
    },
    {
      type: 'entry_upsert',
      index: 1,
      entry: {
        role: 'assistant',
        content: '',
        timestamp: '<ts>',
        isStreaming: true,
      },
    },
    {
      type: 'entry_delta',
      index: 1,
      delta: '18 degrees and clear',
    },
    {
      type: 'entry_upsert',
      index: 2,
      entry: {
        role: 'tool',
        toolName: 'weather',
        toolInput: {
          city: 'Berlin',
        },
        timestamp: '<ts>',
      },
    },
    {
      type: 'entry_commit',
      index: 1,
    },
    {
      type: 'entry_upsert',
      index: 3,
      entry: {
        role: 'assistant',
        content: '18 degrees and clear',
        timestamp: '<ts>',
        isStreaming: false,
      },
    },
    {
      type: 'entry_upsert',
      index: 1,
      entry: {
        role: 'assistant',
        content: '',
        timestamp: '<ts>',
        isStreaming: false,
      },
    },
    {
      type: 'entry_skip',
      index: 4,
    },
    {
      type: 'stream_end',
    },
  ],
  rateLimited: [
    {
      type: 'entry_upsert',
      index: 0,
      entry: {
        role: 'user',
        content: 'What is the weather in Berlin?',
        timestamp: '<ts>',
      },
    },
    {
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'AI service is busy, please try again',
    },
    {
      type: 'stream_end',
    },
  ],
} as const satisfies Record<string, readonly OutgoingMessage[]>;
