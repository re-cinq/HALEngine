import type {PromptMask} from './withMask.js';
import type {AIProvider, MessageChunk, SendMessageParams, StructuredOutputParams} from '../types/ai.js';

// The consumer's side of the contract: a detector for one name and one reference, tokens at most ten characters long.
const PAIRS: Array<[string, string]> = [
  ['Ada Example', '[[NAME_1]]'],
  ['OLT-2026-0001', '[[REF_1]]'],
];

/** A PromptMask over two fixed pairs that counts its bindings; `onApply` runs before every apply, so a test can make one throw. */
export function fixtureMask(onApply?: () => void): {mask: PromptMask; binds: () => number} {
  let binds = 0;
  return {
    binds: () => binds,
    mask: {
      maxTokenLength: 10,
      bind: () => {
        binds++;
        return {
          apply: text => {
            onApply?.();
            return PAIRS.reduce((masked, [real, token]) => masked.split(real).join(token), text);
          },
          restore: text => PAIRS.reduce((restored, [real, token]) => restored.split(token).join(real), text),
        };
      },
    },
  };
}

export const text = (value: string): MessageChunk => ({type: 'text', text: value});
export const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};

/** A provider that answers each call with the next round, the last repeating, and keeps every request it was sent. */
export function recording(...rounds: MessageChunk[][]): {provider: AIProvider; sent: SendMessageParams[]} {
  const sent: SendMessageParams[] = [];
  let call = 0;
  return {
    sent,
    provider: {
      async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
        sent.push(params);
        yield* rounds[Math.min(call++, rounds.length - 1)];
      },
      generateStructured: async <T>(params: StructuredOutputParams<T>) => params as unknown as T,
    },
  };
}
