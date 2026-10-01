import {WebSocket} from 'ws';
import type {SessionEntry} from '../../types/session.js';
import type {ChatSession} from '../../types/session.js';
import {ErrorCodes} from '../../types/messages.js';
import type {OutgoingMessage} from '../../types/messages.js';
import {ThinkingTagParser, ParsedSegment} from '../../infrastructure/parsers/thinkingTagParser.js';
import {validateMessage} from './validation.js';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import {AIError} from '../../types/ai.js';
import type {MessageChunk} from '../../types/ai.js';
import {
  createUserEntry,
  createAssistantEntry,
  createThinkingEntry,
  createToolEntry,
} from '../../orchestration/entryFactories.js';
import {appendEntry, appendDelta, commitEntry, markTruncated} from '../../orchestration/entryMutations.js';
import {sendJson, sendUpsert, sendDelta, sendCommit, sendSkip, sendError, sendStreamEnd} from './sender.js';
import {log} from '../../shared/logger.js';

interface StreamState {
  thinkingIndex: number | null;
  assistantIndex: number | null;
  suppressOutput: boolean;
  sentAssistantIndices: number[];
}

type StateIndexKey = 'thinkingIndex' | 'assistantIndex';
type EntryFactory = typeof createThinkingEntry | typeof createAssistantEntry;
export function createMessageHandler(orchestrator: ChatOrchestrator) {
  return async function handleMessage(ws: WebSocket, session: ChatSession, rawMessage: unknown): Promise<void> {
    try {
      await dispatchMessage(ws, session, orchestrator, rawMessage);
    } finally {
      // Every user_message ends in exactly one stream_end, errored or not; a ping never gets one.
      if (isUserMessageFrame(rawMessage)) sendStreamEnd(ws);
    }
  };
}

async function dispatchMessage(
  ws: WebSocket,
  session: ChatSession,
  orchestrator: ChatOrchestrator,
  rawMessage: unknown
): Promise<void> {
  const validation = validateMessage(rawMessage);

  if (!validation.valid) {
    log.warn('message', 'validation failed', {error: validation.error});
    sendError(ws, ErrorCodes.INVALID_MESSAGE, validation.error);
    return;
  }

  const message = validation.data;

  await wsErrorHandler(ws, async () => {
    if (message.type === 'user_message') {
      await handleUserMessage(ws, session, orchestrator, message.content);
    }

    if (message.type === 'ping') {
      handlePing(ws, message.timestamp);
    }
  });
}

// Read from the raw frame, so a user_message that fails validation still gets its stream_end.
function isUserMessageFrame(rawMessage: unknown): boolean {
  return typeof rawMessage === 'object' && rawMessage !== null && Reflect.get(rawMessage, 'type') === 'user_message';
}

async function wsErrorHandler(ws: WebSocket, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = error instanceof AIError ? error.code : 'UNKNOWN';
    log.error('message', 'handling error', {error: message, code});
    if (error instanceof AIError && error.code === 'RATE_LIMITED') {
      sendError(ws, ErrorCodes.RATE_LIMITED, 'AI service is busy, please try again');
      return;
    }
    sendError(ws, ErrorCodes.SERVER_ERROR, 'Failed to process message');
  }
}

async function handleUserMessage(
  ws: WebSocket,
  session: ChatSession,
  orchestrator: ChatOrchestrator,
  content: string
): Promise<void> {
  log.info('message', 'user message received', {sessionId: session.sessionId, contentLength: content.length});

  const userEntry = createUserEntry(content);
  const userIndex = appendEntry(session, userEntry);
  sendUpsert(ws, userIndex, userEntry);

  const parser = new ThinkingTagParser();
  const state: StreamState = {
    thinkingIndex: null,
    assistantIndex: null,
    suppressOutput: false,
    sentAssistantIndices: [],
  };

  let textChunkCount = 0;

  try {
    for await (const chunk of orchestrator.processMessageStream(session)) {
      textChunkCount = logChunk(chunk, textChunkCount);
      processChunk(ws, session, state, parser, chunk);
    }
  } finally {
    // Anything still open here was cut short: a stop has already flushed the parser and committed every entry it opened.
    flushHeldText(ws, session, state, parser);
    closeCutOff(ws, session, state, 'thinkingIndex');
    closeCutOff(ws, session, state, 'assistantIndex');
  }

  if (textChunkCount > 0) {
    log.debug('stream', `received ${textChunkCount} text chunks`);
  }
  log.info('stream', 'stream completed', {suppressed: state.suppressOutput, entries: session.entries.length});
}

// Diagnostics only: counts a run of text chunks so it is logged once, not per token.
function logChunk(chunk: MessageChunk, textChunkCount: number): number {
  if (chunk.type === 'text') return textChunkCount + 1;

  if (textChunkCount > 0) {
    log.debug('stream', `received ${textChunkCount} text chunks`);
  }

  if (chunk.type === 'tool_result') {
    log.debug('stream', 'tool_result chunk', {
      messageCount: chunk.clientMessages.length,
      types: chunk.clientMessages.map(m => m.type),
    });
    return 0;
  }

  log.debug('stream', 'chunk', {type: chunk.type});
  return 0;
}

function processChunk(
  ws: WebSocket,
  session: ChatSession,
  state: StreamState,
  parser: ThinkingTagParser,
  chunk: MessageChunk
): void {
  if (chunk.type === 'text') return processTextChunk(ws, session, state, parser, chunk.text);
  if (chunk.type === 'tool_use') return processToolUseChunk(ws, session, chunk.toolCall);
  if (chunk.type === 'tool_result') return processToolResultChunk(ws, chunk.clientMessages);
  if (chunk.type === 'suppress_output') return processSuppressChunk(ws, session, state);
  if (chunk.type === 'stop') return processStopChunk(ws, session, state, parser);
}

function processTextChunk(
  ws: WebSocket,
  session: ChatSession,
  state: StreamState,
  parser: ThinkingTagParser,
  text: string
): void {
  const segments = parser.push(text);
  for (const segment of segments) {
    handleTextSegment(ws, session, state, segment);
  }
}

function handleTextSegment(ws: WebSocket, session: ChatSession, state: StreamState, segment: ParsedSegment): void {
  if (segment.type === 'thinking') {
    streamSegment(ws, session, state, 'thinkingIndex', createThinkingEntry, segment.content);
    return;
  }
  commitAndClear(ws, session, state, 'thinkingIndex');
  streamSegment(ws, session, state, 'assistantIndex', createAssistantEntry, segment.content);
}

function streamSegment(
  ws: WebSocket,
  session: ChatSession,
  state: StreamState,
  key: StateIndexKey,
  createEntry: EntryFactory,
  content: string
): void {
  const isNew = initSegment(session, state, key, createEntry);
  if (isNew && state.suppressOutput) skipSuppressed(ws, session, state[key]!);
  if (isNew && !state.suppressOutput) sendUpsert(ws, state[key]!, session.entries[state[key]!]);
  appendDelta(session, state[key]!, content);
  if (!state.suppressOutput) sendDelta(ws, state[key]!, content);
}

// Stored as suppressed, so a replay on resume shows the client what it saw live and not the text a tool hid.
function skipSuppressed(ws: WebSocket, session: ChatSession, index: number): void {
  markSuppressed(session, index);
  sendSkip(ws, index);
}

function markSuppressed(session: ChatSession, index: number): void {
  const entry = session.entries[index];
  if (entry.role === 'assistant' || entry.role === 'thinking') entry.suppressed = true;
}

function initSegment(session: ChatSession, state: StreamState, key: StateIndexKey, createEntry: EntryFactory): boolean {
  if (state[key] !== null) return false;
  state[key] = appendEntry(session, createEntry());
  return true;
}

function commitAndClear(ws: WebSocket, session: ChatSession, state: StreamState, key: StateIndexKey): void {
  const index = state[key];
  if (index === null) return;

  commitEntry(session, index);
  state[key] = null;

  // Only what the client received can be retracted, and only assistant entries.
  if (state.suppressOutput) return;

  sendCommit(ws, index);
  if (key === 'assistantIndex') state.sentAssistantIndices.push(index);
}

function processToolUseChunk(
  ws: WebSocket,
  session: ChatSession,
  toolCall: {name: string; input: Record<string, unknown>}
): void {
  const toolEntry = createToolEntry(toolCall.name, toolCall.input);
  const toolIndex = appendEntry(session, toolEntry);
  sendUpsert(ws, toolIndex, toolEntry);
}

function processToolResultChunk(ws: WebSocket, clientMessages: OutgoingMessage[]): void {
  for (const msg of clientMessages) {
    log.debug('stream', 'forwarding client message to frontend', {
      type: msg.type,
      index: 'index' in msg ? msg.index : undefined,
    });
    sendJson(ws, msg);
  }
}

// Retracts what the client saw: every assistant entry sent so far is re-sent blank.
function processSuppressChunk(ws: WebSocket, session: ChatSession, state: StreamState): void {
  log.debug('stream', 'suppression activated', {blankingEntries: state.sentAssistantIndices});

  for (const idx of state.sentAssistantIndices) {
    sendUpsert(ws, idx, {...session.entries[idx], content: ''} as SessionEntry);
    markSuppressed(session, idx);
  }
  markOpenSuppressed(session, state);

  state.sentAssistantIndices = [];
  state.suppressOutput = true;
}

// An open entry stops streaming here, so the client never sees the text it gathers next; a replay must not either.
function markOpenSuppressed(session: ChatSession, state: StreamState): void {
  if (state.thinkingIndex !== null) markSuppressed(session, state.thinkingIndex);
  if (state.assistantIndex !== null) markSuppressed(session, state.assistantIndex);
}

function processStopChunk(ws: WebSocket, session: ChatSession, state: StreamState, parser: ThinkingTagParser): void {
  flushHeldText(ws, session, state, parser);
  commitOpenEntries(ws, session, state);
}

// The parser holds back a tail that might open a tag; without this the tail of a cut-off answer would be lost.
function flushHeldText(ws: WebSocket, session: ChatSession, state: StreamState, parser: ThinkingTagParser): void {
  for (const segment of parser.flush()) {
    handleTextSegment(ws, session, state, segment);
  }
}

// The flag lives on the stored entry even when suppressed; only a visible entry is re-sent, which is how a live client learns it.
function closeCutOff(ws: WebSocket, session: ChatSession, state: StreamState, key: StateIndexKey): void {
  const index = state[key];
  if (index === null) return;
  markTruncated(session, index);
  if (!state.suppressOutput) sendUpsert(ws, index, session.entries[index]);
  commitAndClear(ws, session, state, key);
}

function commitOpenEntries(ws: WebSocket, session: ChatSession, state: StreamState): void {
  commitAndClear(ws, session, state, 'thinkingIndex');
  commitAndClear(ws, session, state, 'assistantIndex');
}

function handlePing(ws: WebSocket, timestamp: number): void {
  ws.send(JSON.stringify({type: 'pong', timestamp}));
}
