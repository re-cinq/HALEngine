import {jest} from '@jest/globals';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';
import type {AIProvider, SendMessageParams} from './types/ai.js';

// Only what the assertion reads back from the command the provider built.
interface Command {
  input: Record<string, unknown>;
}

const send = jest.fn<(command: Command) => Promise<unknown>>();

// The SDK is an optional peer the provider loads through this helper, so the helper is the seam.
jest.unstable_mockModule('./providers/requireOptionalPeer.js', () => ({
  requireOptionalPeer: () => ({
    BedrockRuntimeClient: class {
      send = send;
    },
    ConverseStreamCommand: class {
      constructor(readonly input: Record<string, unknown>) {}
    },
  }),
}));
const {createBedrockProvider} = await import('./providers/bedrock/bedrockProvider.js');

describe('an empty tool registry', () => {
  it('calls sendMessage with tools undefined, and Bedrock builds a request with no toolConfig key', async () => {
    send.mockResolvedValue({
      stream: (async function* () {
        yield {messageStop: {stopReason: 'end_turn'}};
      })(),
    });
    const bedrock = createBedrockProvider({type: 'bedrock', modelId: 'm', region: 'eu-west-1', maxTokens: 64});
    const seen: SendMessageParams[] = [];
    const provider: AIProvider = {
      sendMessage: params => {
        seen.push(params);
        return bedrock.sendMessage(params);
      },
      generateStructured: params => bedrock.generateStructured(params),
    };

    await createChatOrchestrator(provider, new PromptBuilder({identity: 'Empty.'}), new ToolRegistry()).processMessage({
      sessionId: 's',
      userId: 'u',
      entries: [{role: 'user', content: 'hi', timestamp: 't'}],
    });

    const [[command]] = send.mock.calls;
    expect({tools: seen.map(params => params.tools), toolConfig: Object.hasOwn(command.input, 'toolConfig')}).toEqual({
      tools: [undefined],
      toolConfig: false,
    });
  });
});
