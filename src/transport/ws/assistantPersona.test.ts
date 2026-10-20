import type {WebSocket} from 'ws';
import {createMessageHandler} from './messageHandler.js';
import {createChatOrchestrator} from '../../orchestration/chatOrchestrator.js';
import type {OrchestratorHooks} from '../../orchestration/chatOrchestrator.js';
import {createAssistantEntry} from '../../orchestration/entryFactories.js';
import {ToolRegistry} from '../../orchestration/tools/registry.js';
import type {ToolResponse} from '../../orchestration/tools/registry.js';
import {PromptBuilder} from '../../infrastructure/builders/promptBuilder.js';
import type {AIProvider, MessageChunk} from '../../types/ai.js';
import type {ChatSession, SessionEntry} from '../../types/session.js';
import type {EntryUpsertMessage, OutgoingMessage} from '../../types/messages.js';

// Real turns through the handler and the orchestrator: the persona is stamped where the two meet.

const text = (value: string): MessageChunk => ({type: 'text', text: value});
const STOP: MessageChunk = {type: 'stop', stopReason: 'end_turn'};
const CALL: MessageChunk = {type: 'tool_use', toolCall: {id: 'c1', name: 'lookup', input: {}}};
const TOOL_STOP: MessageChunk = {type: 'stop', stopReason: 'tool_use'};

// Each provider call answers with the next round, the last one repeating.
function scripted(...rounds: MessageChunk[][]): AIProvider {
  let call = 0;
  return {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      const round = rounds[Math.min(call, rounds.length - 1)];
      call++;
      yield* round;
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
}

interface Turn {
  provider: AIProvider;
  hooks?: OrchestratorHooks;
  tool?: () => Promise<ToolResponse>;
}

// Runs one user message on `session` and returns the frames the client was sent.
async function turnOn(session: ChatSession, {provider, hooks, tool}: Turn): Promise<OutgoingMessage[]> {
  const registry = new ToolRegistry();
  if (tool) registry.register({name: 'lookup', description: 'Looks it up.', inputSchema: {type: 'object'}}, tool);
  const orchestrator = createChatOrchestrator(provider, new PromptBuilder({identity: 'Persona test.'}), registry, {
    hooks,
  });
  const sent: OutgoingMessage[] = [];
  const ws = {send: (raw: string) => sent.push(JSON.parse(raw) as OutgoingMessage)} as unknown as WebSocket;
  await createMessageHandler(orchestrator)(ws, session, {type: 'user_message', content: 'hello'});
  return sent;
}

const sessionWith = (activePersona?: string): ChatSession => ({
  sessionId: 's1',
  userId: 'u1',
  entries: [],
  ...(activePersona === undefined ? {} : {activePersona}),
});

const assistantUpserts = (sent: OutgoingMessage[]): EntryUpsertMessage[] =>
  sent.filter(
    (frame): frame is EntryUpsertMessage => frame.type === 'entry_upsert' && frame.entry.role === 'assistant'
  );

const personaOf = (entry: SessionEntry): string | undefined =>
  entry.role === 'assistant' && Object.hasOwn(entry, 'persona') ? entry.persona : undefined;

describe('the persona on an assistant entry', () => {
  it("creates an assistant entry carrying persona 'support', and one with no persona key when none is given", () => {
    const given = createAssistantEntry('support');
    const bare = createAssistantEntry();

    expect({
      given,
      bareHasKey: Object.hasOwn(bare, 'persona'),
      bareJson: Object.keys(JSON.parse(JSON.stringify(bare)) as object).sort(),
    }).toMatchObject({
      given: {role: 'assistant', content: '', isStreaming: true, persona: 'support'},
      bareHasKey: false,
      bareJson: ['content', 'isStreaming', 'role', 'timestamp'],
    });
  });

  it("sends the assistant entry_upsert with persona 'support' when the session's activePersona is support", async () => {
    const sent = await turnOn(sessionWith('support'), {provider: scripted([text('Hej '), text('igen'), STOP])});

    expect(assistantUpserts(sent).map(frame => personaOf(frame.entry))).toEqual(['support']);
  });

  it('sends an assistant entry with no persona key when activePersona is unset, the fields the release before carried', async () => {
    const sent = await turnOn(sessionWith(), {provider: scripted([text('Hej '), text('igen'), STOP])});

    expect(assistantUpserts(sent).map(frame => Object.keys(frame.entry).sort())).toEqual([
      ['content', 'isStreaming', 'role', 'timestamp'],
    ]);
  });

  it("stamps 'p-two' when beforeModelResponse changes the session's activePersona from 'p-one' mid-turn", async () => {
    const hooks: OrchestratorHooks = {
      beforeModelResponse: async (session, systemPrompt) => {
        session.activePersona = 'p-two';
        return systemPrompt;
      },
    };

    const sent = await turnOn(sessionWith('p-one'), {provider: scripted([text('answer'), STOP]), hooks});

    expect(assistantUpserts(sent).map(frame => personaOf(frame.entry))).toEqual(['p-two']);
  });

  it("stamps each answer with the persona active for its own message, 'p-one' then 'p-two' in one session", async () => {
    const session = sessionWith('p-one');
    await turnOn(session, {provider: scripted([text('first'), STOP])});
    session.activePersona = 'p-two';
    await turnOn(session, {provider: scripted([text('second'), STOP])});

    const answers = session.entries.filter(entry => entry.role === 'assistant');
    expect(answers.map(entry => [entry.content, personaOf(entry)])).toEqual([
      ['first', 'p-one'],
      ['second', 'p-two'],
    ]);
  });

  it('leaves the persona off thinking and tool entries, and appends an assistant entry a tool supplied as the tool built it', async () => {
    const supplied: SessionEntry = {role: 'assistant', content: 'from the tool', timestamp: 't', isStreaming: false};
    const session = sessionWith('support');

    await turnOn(session, {
      provider: scripted([text('<thinking>hm</thinking>'), CALL, TOOL_STOP], [text('done'), STOP]),
      tool: async () => ({result: 'found', clientMessages: [{type: 'entry_upsert', index: 0, entry: supplied}]}),
    });

    expect(
      session.entries.map(entry => [entry.role, 'content' in entry ? entry.content : '', personaOf(entry)])
    ).toEqual([
      ['user', 'hello', undefined],
      ['thinking', 'hm', undefined],
      ['tool', '', undefined],
      ['assistant', 'from the tool', undefined],
      ['assistant', 'done', 'support'],
    ]);
  });

  it('keeps the persona on the blanking entry_upsert when a tool suppresses an answer already sent', async () => {
    const sent = await turnOn(sessionWith('support'), {
      provider: scripted([text('let me check'), CALL, TOOL_STOP], [text('hidden'), STOP]),
      tool: async () => ({result: 'found', suppressAssistantResponse: true}),
    });

    expect(
      assistantUpserts(sent).map(frame => ({
        index: frame.index,
        content: 'content' in frame.entry ? frame.entry.content : undefined,
        persona: personaOf(frame.entry),
      }))
    ).toEqual([
      {index: 1, content: '', persona: 'support'},
      {index: 1, content: '', persona: 'support'},
    ]);
  });
});
