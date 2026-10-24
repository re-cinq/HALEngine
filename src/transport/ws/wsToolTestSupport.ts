import type {AIProvider, Message, MessageChunk} from '../../types/ai.js';
import type {OutgoingMessage} from '../../types/messages.js';

export const WANTS_TOOLS: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
export const ANSWER: MessageChunk[] = [
  {type: 'text', text: 'All done.'},
  {type: 'stop', stopReason: 'end_turn'},
];

export const call = (id: string, name: string, input: Record<string, unknown> = {}): MessageChunk => ({
  type: 'tool_use',
  toolCall: {id, name, input},
});

export const kinds = (frames: OutgoingMessage[]): string[] =>
  frames.map(frame => (frame.type === 'error' ? `error ${frame.code}` : frame.type));

export function makeScriptedProvider(rounds: MessageChunk[][]): {provider: AIProvider; requests: Message[][]} {
  const requests: Message[][] = [];
  const provider: AIProvider = {
    async *sendMessage({messages}) {
      requests.push([...messages]);
      yield* rounds[requests.length - 1] ?? ANSWER;
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
  return {provider, requests};
}
