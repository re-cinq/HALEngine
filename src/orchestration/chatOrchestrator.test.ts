import {createChatOrchestrator} from './chatOrchestrator.js';
import type {OrchestratorHooks} from './chatOrchestrator.js';
import type {AIProvider, MessageChunk, SendMessageParams, UsageMetadata} from '../types/ai.js';
import {AIError} from '../types/ai.js';
import type {ChatSession} from '../types/session.js';
import {PromptBuilder} from '../infrastructure/builders/promptBuilder.js';
import {ToolRegistry} from './tools/registry.js';
import type {ToolResponse} from './tools/registry.js';
import type {OutgoingMessage} from '../types/messages.js';
import type {SessionEntry} from '../types/session.js';

// Fixed: nothing asserts on it, and new Date() would tie the run to the clock.
const SENT_AT = '2026-01-01T00:00:00.000Z';

// One expect per test needs the rejection as a value rather than a matcher.
const outcomeOf = (call: Promise<unknown>): Promise<string> =>
  call.then(() => 'resolved without throwing').catch((error: Error) => error.message);

function createSession(content: string): ChatSession {
  return {
    sessionId: 's1',
    userId: 'u1',
    entries: [{role: 'user', content, timestamp: SENT_AT}],
  };
}

function createMockProvider(response: string, usage?: UsageMetadata): AIProvider {
  return {
    async *sendMessage(_params: SendMessageParams): AsyncGenerator<MessageChunk> {
      yield {type: 'text', text: response};
      yield {type: 'stop', stopReason: 'end_turn', usage};
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
}

function createErrorProvider(error: Error): AIProvider {
  return {
    // eslint-disable-next-line require-yield
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      throw error;
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
}

const promptBuilder = new PromptBuilder({identity: 'You are a test assistant.'});

type RecordedHook =
  | 'beforeSession'
  | 'beforeUserInput'
  | 'afterUserInput'
  | 'beforeModelResponse'
  | 'afterModelResponse'
  | 'afterSession'
  | 'onError';

// Only the named hooks are installed: one that merely exists changes the observed order.
const recordingHooks = (callOrder: string[], names: RecordedHook[]): OrchestratorHooks => {
  const all: Required<OrchestratorHooks> = {
    beforeSession: async () => void callOrder.push('beforeSession'),
    beforeUserInput: async (_session, msg) => {
      callOrder.push('beforeUserInput');
      return msg;
    },
    afterUserInput: async () => void callOrder.push('afterUserInput'),
    beforeModelResponse: async (_session, systemPrompt) => {
      callOrder.push('beforeModelResponse');
      return systemPrompt;
    },
    afterModelResponse: async () => void callOrder.push('afterModelResponse'),
    afterSession: async () => void callOrder.push('afterSession'),
    onError: async () => void callOrder.push('onError'),
  };

  return Object.fromEntries(names.map(name => [name, all[name]])) as OrchestratorHooks;
};

// Records what the orchestrator actually sent, for tests that assert on the request.
const capturingProvider = (): {provider: AIProvider; sent: {systemPrompt: string; lastUserContent: string}} => {
  const sent = {systemPrompt: '', lastUserContent: ''};

  return {
    sent,
    provider: {
      async *sendMessage(params: SendMessageParams): AsyncGenerator<MessageChunk> {
        sent.systemPrompt = params.systemPrompt;
        const last = params.messages[params.messages.length - 1];
        sent.lastUserContent = typeof last.content === 'string' ? last.content : '';
        yield {type: 'text', text: 'ok'};
        yield {type: 'stop', stopReason: 'end_turn'};
      },
      async generateStructured<T>(): Promise<T> {
        return {} as T;
      },
    },
  };
};

describe('ChatOrchestrator hooks', () => {
  describe('beforeSession', () => {
    it('called before anything else', async () => {
      const callOrder: string[] = [];
      const hooks = recordingHooks(callOrder, ['beforeSession', 'beforeUserInput', 'beforeModelResponse']);

      const orchestrator = createChatOrchestrator(createMockProvider('hi'), promptBuilder, undefined, {hooks});
      await orchestrator.processMessage(createSession('hello'));

      expect(callOrder[0]).toBe('beforeSession');
    });
  });

  describe('afterSession', () => {
    it('called after everything completes', async () => {
      const callOrder: string[] = [];
      const hooks = recordingHooks(callOrder, ['afterModelResponse', 'afterSession']);

      const orchestrator = createChatOrchestrator(createMockProvider('hi'), promptBuilder, undefined, {hooks});
      await orchestrator.processMessage(createSession('hello'));

      expect(callOrder).toEqual(['afterModelResponse', 'afterSession']);
    });

    it('called even when an error occurs', async () => {
      let afterSessionCalled = false;
      const hooks: OrchestratorHooks = {
        onError: async () => {},
        afterSession: async () => {
          afterSessionCalled = true;
        },
      };

      const orchestrator = createChatOrchestrator(createErrorProvider(new Error('boom')), promptBuilder, undefined, {
        hooks,
      });
      const outcome = await outcomeOf(orchestrator.processMessage(createSession('hello')));

      expect({outcome, afterSessionCalled}).toEqual({outcome: 'boom', afterSessionCalled: true});
    });
  });

  describe('beforeUserInput', () => {
    it('receives the last user message content', async () => {
      let receivedMessage = '';
      const hooks: OrchestratorHooks = {
        beforeUserInput: async (_session, userMessage) => {
          receivedMessage = userMessage;
          return userMessage;
        },
      };

      const orchestrator = createChatOrchestrator(createMockProvider('ok'), promptBuilder, undefined, {hooks});
      await orchestrator.processMessage(createSession('my answer'));

      expect(receivedMessage).toBe('my answer');
    });

    it('modifies user message when returning different value', async () => {
      const {provider, sent} = capturingProvider();

      const hooks: OrchestratorHooks = {
        beforeUserInput: async (_session, _msg) => 'sanitized input',
      };

      const orchestrator = createChatOrchestrator(provider, promptBuilder, undefined, {hooks});
      await orchestrator.processMessage(createSession('raw input'));

      expect(sent.lastUserContent).toBe('sanitized input');
    });
  });

  describe('afterUserInput', () => {
    it('receives user message after any beforeUserInput modification', async () => {
      let afterReceived = '';
      const hooks: OrchestratorHooks = {
        beforeUserInput: async (_s, _msg) => 'modified',
        afterUserInput: async (_s, msg) => {
          afterReceived = msg;
        },
      };

      const orchestrator = createChatOrchestrator(createMockProvider('ok'), promptBuilder, undefined, {hooks});
      await orchestrator.processMessage(createSession('original'));

      expect(afterReceived).toBe('modified');
    });
  });

  describe('beforeModelResponse', () => {
    it('replaces system prompt with returned value', async () => {
      const {provider, sent} = capturingProvider();

      const hooks: OrchestratorHooks = {
        beforeModelResponse: async (_session, _basePrompt) => 'Custom prompt for this question',
      };

      const orchestrator = createChatOrchestrator(provider, promptBuilder, undefined, {hooks});
      await orchestrator.processMessage(createSession('hello'));

      expect(sent.systemPrompt).toBe('Custom prompt for this question');
    });
  });

  describe('afterModelResponse', () => {
    it('receives collected response text and usage', async () => {
      const usage: UsageMetadata = {inputTokens: 10, outputTokens: 5, totalTokens: 15};
      let receivedText = '';
      let receivedUsage: UsageMetadata | undefined;

      const hooks: OrchestratorHooks = {
        afterModelResponse: async (_session, text, u) => {
          receivedText = text;
          receivedUsage = u;
        },
      };

      const orchestrator = createChatOrchestrator(createMockProvider('hello world', usage), promptBuilder, undefined, {
        hooks,
      });
      await orchestrator.processMessage(createSession('hi'));

      expect({receivedText, receivedUsage}).toEqual({receivedText: 'hello world', receivedUsage: usage});
    });

    it('not called when stream throws', async () => {
      let afterCalled = false;
      const hooks: OrchestratorHooks = {
        afterModelResponse: async () => {
          afterCalled = true;
        },
        onError: async () => {},
      };

      const orchestrator = createChatOrchestrator(
        createErrorProvider(new AIError('fail', 'TEST')),
        promptBuilder,
        undefined,
        {hooks}
      );
      const outcome = await outcomeOf(orchestrator.processMessage(createSession('hello')));

      expect({outcome, afterCalled}).toEqual({outcome: 'fail', afterCalled: false});
    });
  });

  describe('onError', () => {
    it('called with session and error when stream fails', async () => {
      let receivedError: Error | undefined;
      const hooks: OrchestratorHooks = {
        onError: async (_session, error) => {
          receivedError = error;
        },
      };

      const orchestrator = createChatOrchestrator(
        createErrorProvider(new AIError('rate limited', 'RATE_LIMITED')),
        promptBuilder,
        undefined,
        {hooks}
      );
      const outcome = await outcomeOf(orchestrator.processMessage(createSession('hello')));

      expect({outcome, receivedErrorMessage: receivedError?.message}).toEqual({
        outcome: 'rate limited',
        receivedErrorMessage: 'rate limited',
      });
    });

    it('error still propagates after onError hook', async () => {
      const hooks: OrchestratorHooks = {
        onError: async () => {},
      };

      const orchestrator = createChatOrchestrator(createErrorProvider(new Error('boom')), promptBuilder, undefined, {
        hooks,
      });
      await expect(orchestrator.processMessage(createSession('hello'))).rejects.toThrow('boom');
    });
  });

  describe('full lifecycle order', () => {
    it('calls all hooks in correct order', async () => {
      const callOrder: string[] = [];
      const usage: UsageMetadata = {inputTokens: 5, outputTokens: 3, totalTokens: 8};

      const hooks: OrchestratorHooks = {
        beforeSession: async () => {
          callOrder.push('beforeSession');
        },
        beforeUserInput: async (_s, msg) => {
          callOrder.push('beforeUserInput');
          return msg;
        },
        afterUserInput: async () => {
          callOrder.push('afterUserInput');
        },
        beforeModelResponse: async (_s, p) => {
          callOrder.push('beforeModelResponse');
          return p;
        },
        afterModelResponse: async () => {
          callOrder.push('afterModelResponse');
        },
        afterSession: async () => {
          callOrder.push('afterSession');
        },
      };

      const orchestrator = createChatOrchestrator(createMockProvider('ok', usage), promptBuilder, undefined, {hooks});
      await orchestrator.processMessage(createSession('hello'));

      expect(callOrder).toEqual([
        'beforeSession',
        'beforeUserInput',
        'afterUserInput',
        'beforeModelResponse',
        'afterModelResponse',
        'afterSession',
      ]);
    });

    it('error path calls onError then afterSession', async () => {
      const callOrder: string[] = [];

      const hooks = recordingHooks(callOrder, [
        'beforeSession',
        'beforeUserInput',
        'afterUserInput',
        'beforeModelResponse',
        'afterModelResponse',
        'onError',
        'afterSession',
      ]);

      const orchestrator = createChatOrchestrator(createErrorProvider(new Error('fail')), promptBuilder, undefined, {
        hooks,
      });
      const outcome = await outcomeOf(orchestrator.processMessage(createSession('hello')));

      expect({outcome, callOrder}).toEqual({
        outcome: 'fail',
        callOrder: [
          'beforeSession',
          'beforeUserInput',
          'afterUserInput',
          'beforeModelResponse',
          'onError',
          'afterSession',
        ],
      });
    });
  });

  describe('no hooks', () => {
    it('works without any hooks configured', async () => {
      const orchestrator = createChatOrchestrator(createMockProvider('hello back'), promptBuilder);
      const result = await orchestrator.processMessage(createSession('hello'));
      expect(result).toBe('hello back');
    });
  });
});

// One scripted round per sendMessage call, to drive the tool loop round by round.
const scriptedProvider = (rounds: MessageChunk[][]): AIProvider => {
  let round = 0;

  return {
    async *sendMessage(): AsyncGenerator<MessageChunk> {
      for (const chunk of rounds[round++] ?? []) yield chunk;
    },
    async generateStructured<T>(): Promise<T> {
      return {} as T;
    },
  };
};

const registryReturning = (response: ToolResponse): ToolRegistry => {
  const registry = new ToolRegistry();
  registry.register(
    {name: 'lookup', description: 'looks things up', inputSchema: {type: 'object'}},
    async () => response
  );
  return registry;
};

const TOOL_CALL: MessageChunk = {type: 'tool_use', toolCall: {id: 'call-1', name: 'lookup', input: {q: 'x'}}};
const STOP_FOR_TOOL: MessageChunk = {type: 'stop', stopReason: 'tool_use'};
const STOP_DONE: MessageChunk = {type: 'stop', stopReason: 'end_turn'};

const chunksFrom = async (stream: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> => {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('ChatOrchestrator tool loop', () => {
  it('runs another round after a tool call and streams both rounds in order', async () => {
    const provider = scriptedProvider([
      [TOOL_CALL, STOP_FOR_TOOL],
      [{type: 'text', text: 'the answer'}, STOP_DONE],
    ]);
    const orchestrator = createChatOrchestrator(provider, promptBuilder, registryReturning({result: 'found it'}));

    const chunks = await chunksFrom(orchestrator.processMessageStream(createSession('ask')));

    expect(chunks.map(c => c.type)).toEqual(['tool_use', 'stop', 'text', 'stop']);
  });

  it('stops after one round when nothing asked for a tool', async () => {
    const provider = scriptedProvider([[{type: 'text', text: 'done'}, STOP_DONE], [{type: 'text', text: 'never'}]]);
    const orchestrator = createChatOrchestrator(provider, promptBuilder, registryReturning({result: 'x'}));

    const text = await orchestrator.processMessage(createSession('ask'));

    expect(text).toBe('done');
  });

  it('stops asking for tools once maxToolRounds is spent', async () => {
    const alwaysTools = Array.from({length: 10}, () => [TOOL_CALL, STOP_FOR_TOOL]);
    const orchestrator = createChatOrchestrator(
      scriptedProvider(alwaysTools),
      promptBuilder,
      registryReturning({result: 'again'}),
      {maxToolRounds: 2}
    );

    const chunks = await chunksFrom(orchestrator.processMessageStream(createSession('ask')));

    expect(chunks.filter(c => c.type === 'tool_use')).toHaveLength(3);
  });

  it('forwards the client messages a tool returned as one tool_result chunk', async () => {
    const forwarded: OutgoingMessage = {type: 'entry_commit', index: 7};
    const orchestrator = createChatOrchestrator(
      scriptedProvider([[TOOL_CALL, STOP_FOR_TOOL], [STOP_DONE]]),
      promptBuilder,
      registryReturning({result: 'r', clientMessages: [forwarded]})
    );

    const chunks = await chunksFrom(orchestrator.processMessageStream(createSession('ask')));

    expect(chunks).toContainEqual({type: 'tool_result', clientMessages: [forwarded]});
  });

  it('appends an upserted entry to the session and rewrites its index to match', async () => {
    const entry: SessionEntry = {role: 'assistant', content: 'from the tool', timestamp: SENT_AT, isStreaming: false};
    const orchestrator = createChatOrchestrator(
      scriptedProvider([[TOOL_CALL, STOP_FOR_TOOL], [STOP_DONE]]),
      promptBuilder,
      registryReturning({result: 'r', clientMessages: [{type: 'entry_upsert', index: 999, entry}]})
    );
    const session = createSession('ask');

    const chunks = await chunksFrom(orchestrator.processMessageStream(session));

    expect(chunks).toContainEqual({
      type: 'tool_result',
      clientMessages: [{type: 'entry_upsert', index: session.entries.length - 1, entry}],
    });
  });

  it('asks for suppression when the tool says the reply is already handled', async () => {
    const orchestrator = createChatOrchestrator(
      scriptedProvider([[TOOL_CALL, STOP_FOR_TOOL], [STOP_DONE]]),
      promptBuilder,
      registryReturning({result: 'r', suppressAssistantResponse: true})
    );

    const chunks = await chunksFrom(orchestrator.processMessageStream(createSession('ask')));

    expect(chunks.map(c => c.type)).toEqual(['tool_use', 'stop', 'suppress_output', 'stop']);
  });

  it('joins the text of every round, not only the last', async () => {
    let seen = '';
    const hooks: OrchestratorHooks = {
      afterModelResponse: async (_session, responseText) => {
        seen = responseText;
      },
    };
    const orchestrator = createChatOrchestrator(
      scriptedProvider([
        [{type: 'text', text: 'first '}, TOOL_CALL, STOP_FOR_TOOL],
        [{type: 'text', text: 'second'}, STOP_DONE],
      ]),
      promptBuilder,
      registryReturning({result: 'r'}),
      {hooks}
    );

    await orchestrator.processMessage(createSession('ask'));

    expect(seen).toBe('first second');
  });

  it('keeps the usage an earlier round reported when a later round reports none', async () => {
    const usage: UsageMetadata = {inputTokens: 11, outputTokens: 3, totalTokens: 14};
    let seen: UsageMetadata | undefined;
    const hooks: OrchestratorHooks = {
      afterModelResponse: async (_session, _text, reported) => {
        seen = reported;
      },
    };
    const orchestrator = createChatOrchestrator(
      scriptedProvider([
        [TOOL_CALL, {type: 'stop', stopReason: 'tool_use', usage}],
        [{type: 'text', text: 'done'}, STOP_DONE],
      ]),
      promptBuilder,
      registryReturning({result: 'r'}),
      {hooks}
    );

    await orchestrator.processMessage(createSession('ask'));

    expect(seen).toEqual(usage);
  });

  it('sums the usage of every round, not only the last', async () => {
    const first: UsageMetadata = {inputTokens: 10, outputTokens: 5, totalTokens: 15};
    const second: UsageMetadata = {inputTokens: 20, outputTokens: 7, totalTokens: 27};
    let seen: UsageMetadata | undefined;
    const hooks: OrchestratorHooks = {
      afterModelResponse: async (_session, _text, reported) => {
        seen = reported;
      },
    };
    const orchestrator = createChatOrchestrator(
      scriptedProvider([
        [TOOL_CALL, {type: 'stop', stopReason: 'tool_use', usage: first}],
        [
          {type: 'text', text: 'done'},
          {type: 'stop', stopReason: 'end_turn', usage: second},
        ],
      ]),
      promptBuilder,
      registryReturning({result: 'r'}),
      {hooks}
    );

    await orchestrator.processMessage(createSession('ask'));

    expect(seen).toEqual({inputTokens: 30, outputTokens: 12, totalTokens: 42});
  });

  it('counts every reporting round even when a round between them reports none', async () => {
    const first: UsageMetadata = {inputTokens: 10, outputTokens: 5, totalTokens: 15};
    const third: UsageMetadata = {inputTokens: 1, outputTokens: 2, totalTokens: 3};
    let seen: UsageMetadata | undefined;
    const hooks: OrchestratorHooks = {
      afterModelResponse: async (_session, _text, reported) => {
        seen = reported;
      },
    };
    const orchestrator = createChatOrchestrator(
      scriptedProvider([
        [TOOL_CALL, {type: 'stop', stopReason: 'tool_use', usage: first}],
        [TOOL_CALL, {type: 'stop', stopReason: 'tool_use'}],
        [
          {type: 'text', text: 'done'},
          {type: 'stop', stopReason: 'end_turn', usage: third},
        ],
      ]),
      promptBuilder,
      registryReturning({result: 'r'}),
      {hooks}
    );

    await orchestrator.processMessage(createSession('ask'));

    expect(seen).toEqual({inputTokens: 11, outputTokens: 7, totalTokens: 18});
  });
});
