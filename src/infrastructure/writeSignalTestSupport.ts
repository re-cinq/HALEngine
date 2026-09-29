import type {AIProvider, MessageChunk} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';
import type {SessionStore} from '../types/sessionStore.js';
import {InMemorySessionStore} from './stores/inMemorySessionStore.js';
import {PromptBuilder} from './builders/promptBuilder.js';

// Shared by the two write-signal suites, which drive the same turn from either side of the transport boundary.

/** An in-memory store whose `save` is the caller's, so a test can record or fail the write. */
export function recordingSessionStore(onSave: (session: ChatSession) => void | Promise<void>): SessionStore {
  return Object.assign(new InMemorySessionStore(), {save: onSave});
}

/** A provider that answers with `text` and stops, which is what commits the assistant entry. */
export function answering(text: string): AIProvider {
  return {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      yield {type: 'text', text};
      yield {type: 'stop', stopReason: 'end_turn'};
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
}

/** A provider that throws before yielding, so the turn reaches `finally` by the error path. */
export function failing(message: string): AIProvider {
  return {
    // eslint-disable-next-line require-yield
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      throw new Error(message);
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
}

/** The prompt builder both suites use; its content is irrelevant to the write signal. */
export const writeSignalPromptBuilder = new PromptBuilder({identity: 'You are a test assistant.'});
