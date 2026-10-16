import {jest} from '@jest/globals';
import {createChatOrchestrator} from './orchestration/chatOrchestrator.js';
import {ToolRegistry} from './orchestration/tools/registry.js';
import {PromptBuilder} from './infrastructure/builders/promptBuilder.js';

// Only what the assertion reads back from the orchestrator's second request.
interface VertexRequest {
  contents: {parts?: Array<Record<string, unknown>>}[];
}

const generateContentStream = jest.fn<(request: VertexRequest) => Promise<unknown>>();

// The SDK is an optional peer the provider loads through this helper, so the helper is the seam.
jest.unstable_mockModule('./providers/requireOptionalPeer.js', () => ({
  requireOptionalPeer: () => ({
    VertexAI: class {
      getGenerativeModel() {
        return {generateContentStream};
      }
    },
  }),
}));
const {createVertexProvider} = await import('./providers/vertex/vertexProvider.js');

// One SDK answer: its chunks, and the promise the SDK drains a copy of them into.
const answer = (...chunks: Record<string, unknown>[]) => ({
  stream: (async function* () {
    yield* chunks;
  })(),
  response: Promise.resolve({}),
});

beforeEach(() => {
  generateContentStream.mockReset();
});

const LOOKUP = {name: 'lookup', args: {query: 'status'}};
const WEATHER = {name: 'weather', args: {city: 'Aarhus'}};

// Runs one turn whose first answer is `parts`, and returns the functionCall parts of the turn's second request.
async function callsSentBack(parts: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  generateContentStream
    .mockResolvedValueOnce(answer({candidates: [{content: {parts}, finishReason: 'STOP'}]}))
    .mockResolvedValueOnce(answer({candidates: [{content: {parts: [{text: 'Done.'}]}, finishReason: 'STOP'}]}));
  const registry = new ToolRegistry();
  for (const name of [LOOKUP.name, WEATHER.name]) {
    registry.register({name, description: `Runs ${name}.`, inputSchema: {type: 'object'}}, async () => 'found');
  }
  const provider = createVertexProvider({type: 'vertex', projectId: 'p', location: 'eu', modelId: 'gemini-3'});
  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'Vertex test.'}), registry);
  await orchestrator.processMessage({
    sessionId: 's',
    userId: 'u',
    entries: [{role: 'user', content: 'go', timestamp: 't'}],
  });
  const {calls} = generateContentStream.mock;
  const second = calls[1]?.[0];
  return (second?.contents.flatMap(content => content.parts ?? []) ?? []).filter(part => 'functionCall' in part);
}

it("sends round one's thoughtSignature sig-1 back on its functionCall part in the turn's next request", async () => {
  const sentBack = await callsSentBack([{functionCall: LOOKUP, thoughtSignature: 'sig-1'}]);

  expect(sentBack).toStrictEqual([{functionCall: LOOKUP, thoughtSignature: 'sig-1'}]);
});

it('sends two calls of one answer back with exactly the signatures they came with, sig-a and sig-b', async () => {
  const sentBack = await callsSentBack([
    {functionCall: LOOKUP, thoughtSignature: 'sig-a'},
    {functionCall: WEATHER, thoughtSignature: 'sig-b'},
  ]);

  expect(sentBack).toStrictEqual([
    {functionCall: LOOKUP, thoughtSignature: 'sig-a'},
    {functionCall: WEATHER, thoughtSignature: 'sig-b'},
  ]);
});

it('sends a call that came unsigned back with no thoughtSignature key, beside a signed one', async () => {
  const sentBack = await callsSentBack([{functionCall: LOOKUP, thoughtSignature: 'sig-1'}, {functionCall: WEATHER}]);

  expect(sentBack).toStrictEqual([{functionCall: LOOKUP, thoughtSignature: 'sig-1'}, {functionCall: WEATHER}]);
});

it('closes the tool loop on its own chunks: the call runs its tool and the next request carries the result', async () => {
  const call = {functionCall: {name: 'lookup', args: {query: 'status'}}};
  generateContentStream
    .mockResolvedValueOnce(answer({candidates: [{content: {parts: [call]}, finishReason: 'STOP'}]}))
    .mockResolvedValueOnce(answer({candidates: [{content: {parts: [{text: 'Done.'}]}, finishReason: 'STOP'}]}));
  const registry = new ToolRegistry();
  registry.register({name: 'lookup', description: 'Looks it up.', inputSchema: {type: 'object'}}, async () => 'found');
  const provider = createVertexProvider({type: 'vertex', projectId: 'p', location: 'europe-west4', modelId: 'gemini'});
  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'Vertex test.'}), registry);

  const reply = await orchestrator.processMessage({
    sessionId: 's',
    userId: 'u',
    entries: [{role: 'user', content: 'look it up', timestamp: 't'}],
  });

  const {calls} = generateContentStream.mock;
  const second = calls[1]?.[0];
  const parts = second?.contents.flatMap(content => content.parts ?? []) ?? [];
  expect({reply, requests: calls.length, answered: parts.filter(part => 'functionResponse' in part)}).toEqual({
    reply: 'Done.',
    requests: 2,
    answered: [{functionResponse: {name: 'lookup', response: {result: 'found'}}}],
  });
});
