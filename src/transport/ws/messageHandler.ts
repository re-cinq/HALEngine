import {WebSocket} from 'ws';
import type {SessionEntry} from '../../types/session.js';
import type {ChatSession} from '../../types/session.js';
import {ErrorCodes} from '../../types/messages.js';
import type {OutgoingMessage} from '../../types/messages.js';
import {ThinkingTagParser, ParsedSegment} from '../../infrastructure/parsers/thinkingTagParser.js';
import {validateMessage} from './validation.js';
import {answerConversationList} from './conversationList.js';
import type {ConversationListDeps} from './conversationList.js';
import type {ValidationFailure, ValidationResult} from './validation.js';
import {PerSessionLock} from '../../shared/perSessionLock.js';
import type {ChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import {AIError} from '../../types/ai.js';
import {clientErrorFor} from '../errorMapping.js';
import type {MessageChunk} from '../../types/ai.js';
import {
  createUserEntry,
  createAssistantEntry,
  createThinkingEntry,
  createToolEntry,
} from '../../orchestration/entryFactories.js';
import {createEntryWriter} from '../../orchestration/entryMutations.js';
import type {EntryWriter} from '../../orchestration/entryMutations.js';
import type {EntryPolicy} from '../../types/entryPolicy.js';
import {sendJson, sendUpsert, sendDelta, sendCommit, sendSkip, sendError, sendStreamEnd} from './sender.js';
import {TOO_MANY_REQUESTS_MESSAGE} from '../rateLimit.js';
import type {RateLimiter} from '../rateLimit.js';
import {log} from '../../shared/logger.js';
import {CredentialExpiredError} from '../../types/credential.js';

interface StreamState {
  thinkingIndex: number | null;
  assistantIndex: number | null;
  suppressOutput: boolean;
  // Every model-authored entry the client was sent, thinking or assistant: what suppression must blank.
  blankableIndices: number[];
  entryWriter: EntryWriter;
}

// What a user message turn runs on: the orchestrator, and the writer holding the same entry policy it does.
interface TurnRunner {
  orchestrator: ChatOrchestrator;
  entryWriter: EntryWriter;
}

type StateIndexKey = 'thinkingIndex' | 'assistantIndex';
type EntryFactory = () => SessionEntry;
/** What the handler needs besides the orchestrator: the store a conversation list reads, whether one is served, and the user's request budget. */
export interface MessageHandlerDeps extends ConversationListDeps {
  rateLimiter?: RateLimiter;
  /** The policy the orchestrator holds too, so an entry this handler writes is kept as one the orchestrator writes is. */
  entries?: EntryPolicy;
}

export function createMessageHandler(orchestrator: ChatOrchestrator, deps?: MessageHandlerDeps) {
  // Keyed by session, not socket: a resumed session can be open on more than one (specs/hal-engine-architecture/spec.md).
  const lock = new PerSessionLock();
  const runner: TurnRunner = {orchestrator, entryWriter: createEntryWriter(deps?.entries)};
  return function handleMessage(
    ws: WebSocket,
    session: ChatSession,
    rawMessage: unknown,
    signal?: AbortSignal
  ): Promise<void> {
    const validation = validateMessage(rawMessage);
    // Queued with no await before it, so a session's user_messages, a refused or failed one too, are answered in arrival order.
    if (isUserMessageFrame(rawMessage)) {
      const refusal = refusedBy(deps?.rateLimiter, session);
      return lock.run(session.sessionId, () =>
        refusal === undefined
          ? answerInTurn(ws, session, runner, validation, signal)
          : refuseInTurn(ws, session, refusal, signal)
      );
    }
    // An async action runs up to its first await at once, so a ping is answered now and a throw stays a rejection.
    return wsErrorHandler(ws, () => answerFrame(ws, session, validation, deps, signal));
  };
}

// The whole answer, an error and the stream_end included, goes out inside the lock: an error frame names no message.
async function answerInTurn(
  ws: WebSocket,
  session: ChatSession,
  runner: TurnRunner,
  validation: ValidationResult,
  signal: AbortSignal | undefined
): Promise<void> {
  if (droppedForClosedSocket(ws, session, signal)) return;
  const startedAt = Date.now();
  try {
    await wsErrorHandler(ws, () => answerUserMessage(ws, session, runner, validation, signal));
  } finally {
    endTurn(ws, session, signal, startedAt);
  }
}

// Its socket closed while it waited: nobody is left to read the answer, and a session's last close took its credentials.
function droppedForClosedSocket(ws: WebSocket, session: ChatSession, signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted && ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED) return false;
  log.info('message', 'queued message dropped: its socket closed', {sessionId: session.sessionId});
  return true;
}

// Consumed on arrival, so the sending rate is what is limited; one bucket per user, whatever the session or socket.
function refusedBy(limiter: RateLimiter | undefined, session: ChatSession): number | undefined {
  const verdict = limiter?.consume(`user:${String(session.userId)}`);
  return verdict === undefined || verdict.allowed ? undefined : verdict.retryAfterMs;
}

// A refusal keeps a turn's shape, one error then stream_end, and runs no model call (specs/hal-engine-rate-limit/spec.md).
async function refuseInTurn(
  ws: WebSocket,
  session: ChatSession,
  retryAfterMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (droppedForClosedSocket(ws, session, signal)) return;
  const startedAt = Date.now();
  try {
    log.warn('rateLimit', 'user_message refused: too many requests', {sessionId: session.sessionId, retryAfterMs});
    sendError(ws, ErrorCodes.TOO_MANY_REQUESTS, TOO_MANY_REQUESTS_MESSAGE, {retryAfterMs});
  } finally {
    endTurn(ws, session, signal, startedAt);
  }
}

// A turn whose socket closed is abandoned rather than ended: nobody is left to read a terminal frame.
function endTurn(ws: WebSocket, session: ChatSession, signal: AbortSignal | undefined, startedAt: number): void {
  if (signal?.aborted) {
    log.info('message', 'turn abandoned: its socket closed', {
      sessionId: session.sessionId,
      elapsedMs: Date.now() - startedAt,
    });
    return;
  }
  sendStreamEnd(ws);
}

async function answerUserMessage(
  ws: WebSocket,
  session: ChatSession,
  runner: TurnRunner,
  validation: ValidationResult,
  signal: AbortSignal | undefined
): Promise<void> {
  const message = validation.valid ? validation.data : undefined;
  if (message?.type === 'user_message') return handleUserMessage(ws, session, runner, message.content, signal);
  // Only an invalid user_message frame reaches here: a valid frame of any other type never enters the lock.
  reportInvalid(ws, validation);
}

// Reports a frame the validator refused, and says whether it did, so each caller can stop there.
function reportInvalid(ws: WebSocket, validation: ValidationResult): validation is ValidationFailure {
  if (validation.valid) return false;

  log.warn('message', 'validation failed', {error: validation.error});
  sendError(ws, ErrorCodes.INVALID_MESSAGE, validation.error);
  return true;
}

// Off the per-session lock: neither frame here is a turn, and a list that queued behind a streaming answer looks broken.
async function answerFrame(
  ws: WebSocket,
  session: ChatSession,
  validation: ValidationResult,
  deps: MessageHandlerDeps | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  if (reportInvalid(ws, validation)) return;

  const message = validation.data;
  if (message.type === 'ping') handlePing(ws, message.timestamp);
  // Abandoned when its socket has closed; otherwise answered even by a handler with no store, since silence is no answer.
  if (message.type !== 'list_conversations' || signal?.aborted) return;

  // The session's own user, never a user the frame names: the frame has no field for one.
  await answerConversationList(ws, session, message, deps);
}

// Read from the raw frame, so a user_message that fails validation still gets its stream_end.
function isUserMessageFrame(rawMessage: unknown): boolean {
  return typeof rawMessage === 'object' && rawMessage !== null && Reflect.get(rawMessage, 'type') === 'user_message';
}

async function wsErrorHandler(ws: WebSocket, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    // A credential the consumer could not renew is no engine fault: the client hears the consumer's own words, unchanged.
    if (error instanceof CredentialExpiredError) {
      log.warn('message', 'a tool credential could not be renewed, so the turn ended');
      sendError(ws, ErrorCodes.CREDENTIAL_EXPIRED, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = error instanceof AIError ? error.code : 'UNKNOWN';
    log.error('message', 'handling error', {error: message, code});
    if (error instanceof AIError) {
      const {code: clientCode, message: sentence} = clientErrorFor(error);
      sendError(ws, clientCode, sentence);
      return;
    }
    // Only a throw that is no AIError is the engine's own defect, the one condition a provider never produces.
    sendError(ws, ErrorCodes.SERVER_ERROR, 'Failed to process message');
  }
}

async function handleUserMessage(
  ws: WebSocket,
  session: ChatSession,
  {orchestrator, entryWriter}: TurnRunner,
  content: string,
  signal: AbortSignal | undefined
): Promise<void> {
  log.info('message', 'user message received', {sessionId: session.sessionId, contentLength: content.length});

  const userEntry = createUserEntry(content);
  const userIndex = entryWriter.appendEntry(session, userEntry);
  sendUpsert(ws, userIndex, userEntry);

  const parser = new ThinkingTagParser();
  const state: StreamState = {
    thinkingIndex: null,
    assistantIndex: null,
    suppressOutput: false,
    blankableIndices: [],
    entryWriter,
  };

  let textChunkCount = 0;

  try {
    for await (const chunk of orchestrator.processMessageStream(session, {signal})) {
      // Its socket closed: breaking returns the run's generator, so the run stops and its own teardown still runs.
      if (signal?.aborted) break;
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
  if (chunk.type === 'tool_use') return processToolUseChunk(ws, session, state, chunk.toolCall);
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
  // Stamped at creation: the entry's first upsert is the only frame that carries it whole to the client.
  streamSegment(
    ws,
    session,
    state,
    'assistantIndex',
    () => createAssistantEntry(session.activePersona),
    segment.content
  );
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
  state.entryWriter.appendDelta(session, state[key]!, content);
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
  state[key] = state.entryWriter.appendEntry(session, createEntry());
  return true;
}

function commitAndClear(ws: WebSocket, session: ChatSession, state: StreamState, key: StateIndexKey): void {
  const index = state[key];
  if (index === null) return;

  state.entryWriter.commitEntry(session, index);
  state[key] = null;

  // Only what the client received can be retracted; a thought as much as an answer, since both are the model's words.
  if (state.suppressOutput) return;

  sendCommit(ws, index);
  state.blankableIndices.push(index);
}

function processToolUseChunk(
  ws: WebSocket,
  session: ChatSession,
  state: StreamState,
  toolCall: {name: string; input: Record<string, unknown>}
): void {
  const toolIndex = state.entryWriter.appendEntry(session, createToolEntry(toolCall.name, toolCall.input));
  // Exempt from suppression by design; sent as stored, so a redacted input looks the same live as on a replay.
  sendUpsert(ws, toolIndex, session.entries[toolIndex]);
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

// Retracts what the client saw: every thinking and assistant entry sent so far is re-sent blank.
function processSuppressChunk(ws: WebSocket, session: ChatSession, state: StreamState): void {
  // Closed as streamed so far: an open answer is then retracted like a sent one, and what follows opens new entries.
  commitOpenEntries(ws, session, state);
  // Indices only: the entries' text is what suppression hides, so it never reaches a log line either.
  log.info('stream', 'suppression activated', {blankingEntries: state.blankableIndices});

  for (const idx of state.blankableIndices) {
    sendUpsert(ws, idx, {...session.entries[idx], content: ''} as SessionEntry);
    markSuppressed(session, idx);
  }

  state.blankableIndices = [];
  state.suppressOutput = true;
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
  state.entryWriter.markTruncated(session, index);
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
