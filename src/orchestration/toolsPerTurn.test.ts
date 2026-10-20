import {createChatOrchestrator} from './chatOrchestrator.js';
import {ToolRegistry} from './tools/registry.js';
import {DEFAULT_TOOL_PREAMBLE, PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import type {AIProvider, MessageChunk, SendMessageParams, ToolDefinition} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';
import {setLogger} from '../shared/logger.js';
import {keepEveryLine} from '../shared/logCaptureTestSupport.js';

const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const callTo = (name: string): MessageChunk[] => [
  {type: 'tool_use', toolCall: {id: 'c1', name, input: {}}},
  {type: 'stop', stopReason: 'tool_use'},
];

const WEATHER: ToolDefinition = {
  name: 'weather',
  description: 'Reports the weather in a city.',
  inputSchema: {type: 'object', properties: {cityName: {type: 'string'}}},
  promptInstructions: 'Call weather for any question about rain.',
};

// Each provider call answers with the next round, the last one repeating, and every request is kept.
function recording(...rounds: MessageChunk[][]): {provider: AIProvider; sent: SendMessageParams[]} {
  const sent: SendMessageParams[] = [];
  const provider: AIProvider = {
    async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
      const round = rounds[Math.min(sent.length, rounds.length - 1)];
      sent.push(params);
      yield* round;
    },
    generateStructured: async <T>() => ({}) as T,
  };
  return {provider, sent};
}

const orchestratorOver = (provider: AIProvider, registry: ToolRegistry) =>
  createChatOrchestrator(provider, new PromptBuilder({identity: 'Tools per turn.'}), registry);

const session = (): ChatSession => ({
  sessionId: 's1',
  userId: 'u1',
  entries: [{role: 'user', content: 'Is it raining?', timestamp: 't'}],
});

afterEach(() => setLogger());

describe('the tool list a turn reads', () => {
  it('sends weather, registered after the orchestrator was built on an empty registry, as the only tool and names it under the default preamble', async () => {
    const registry = new ToolRegistry();
    const {provider, sent} = recording([STOP]);
    const orchestrator = orchestratorOver(provider, registry);

    registry.register(WEATHER, async () => 'sunny');
    await orchestrator.processMessage(session());

    const [{tools, systemPrompt}] = sent;
    expect({
      tools,
      named: systemPrompt.includes('weather: Call weather for any question about rain.'),
      preamble: systemPrompt.includes(DEFAULT_TOOL_PREAMBLE),
      literal: systemPrompt.includes('USE THE PROVIDED TOOLS'),
    }).toEqual({tools: [WEATHER], named: true, preamble: true, literal: true});
  });

  it('sends tools undefined on the first turn and weather alone on the second when weather is registered between them', async () => {
    const registry = new ToolRegistry();
    const {provider, sent} = recording([STOP]);
    const orchestrator = orchestratorOver(provider, registry);

    await orchestrator.processMessage(session());
    registry.register(WEATHER, async () => 'sunny');
    await orchestrator.processMessage(session());

    expect(sent.map(params => params.tools)).toEqual([undefined, [WEATHER]]);
  });

  it('keeps weather, registered by an executor mid-turn, out of round 2 of that turn and sends it from the next turn', async () => {
    const registry = new ToolRegistry();
    registry.register(
      {name: 'probe', description: 'Probes for capabilities.', inputSchema: {type: 'object'}},
      async () => {
        registry.register(WEATHER, async () => 'sunny');
        return 'probed';
      }
    );
    const {provider, sent} = recording(callTo('probe'), [STOP]);
    const orchestrator = orchestratorOver(provider, registry);

    await orchestrator.processMessage(session());
    await orchestrator.processMessage(session());

    expect(sent.map(params => params.tools?.map(tool => tool.name))).toEqual([
      ['probe'],
      ['probe'],
      ['probe', 'weather'],
    ]);
  });

  it('invokes a definition thunk once in each of two turns that call no tool, so the second turn sends its changed description', async () => {
    const registry = new ToolRegistry();
    const invoked: string[] = [];
    let description = 'First description.';
    registry.register(
      () => {
        invoked.push(description);
        return {...WEATHER, description};
      },
      async () => 'sunny'
    );
    invoked.length = 0;
    const {provider, sent} = recording([STOP]);
    const orchestrator = orchestratorOver(provider, registry);

    await orchestrator.processMessage(session());
    description = 'Second description.';
    await orchestrator.processMessage(session());

    expect({invoked, sent: sent.map(({tools}) => tools?.[0]?.description)}).toEqual({
      invoked: ['First description.', 'Second description.'],
      sent: ['First description.', 'Second description.'],
    });
  });

  it('invokes a definition thunk twice in a turn that calls its tool once: at the turn start, then for the call', async () => {
    const registry = new ToolRegistry();
    let invocations = 0;
    registry.register(
      () => {
        invocations++;
        return WEATHER;
      },
      async () => 'sunny'
    );
    invocations = 0;
    const {provider} = recording(callTo('weather'), [STOP]);

    await orchestratorOver(provider, registry).processMessage(session());

    expect(invocations).toBe(2);
  });

  it('writes no tool description, input schema or prompt instructions to the log over a turn that calls the tool', async () => {
    const lines = keepEveryLine();
    const registry = new ToolRegistry();
    registry.register(WEATHER, async () => 'sunny');
    const {provider} = recording(callTo('weather'), [STOP]);

    await orchestratorOver(provider, registry).processMessage(session());

    const logged = JSON.stringify(lines);
    expect({
      lines: lines.length > 0,
      description: logged.includes(WEATHER.description),
      schema: logged.includes('cityName'),
      instructions: logged.includes('any question about rain'),
    }).toEqual({lines: true, description: false, schema: false, instructions: false});
  });
});
