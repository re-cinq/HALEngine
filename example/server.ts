// #region quick-start
import {createHalEngine, log, ToolRegistry} from '../src/index.js';

const tools = new ToolRegistry();

tools.register(
  {
    name: 'get_weather',
    description: 'Get current weather for a city',
    inputSchema: {
      type: 'object',
      properties: {
        city: {type: 'string', description: 'City name'},
      },
      required: ['city'],
    },
    promptInstructions: 'Use this tool when the user asks about weather in a specific city.',
    examplePrompts: ['What is the weather in Berlin?', 'Is it raining in Tokyo?'],
  },
  async input => {
    const city = input.city as string;
    return `Weather in ${city}: 22C, partly cloudy, wind 12 km/h NW`;
  }
);

const engine = createHalEngine({
  provider: {type: 'mock'},
  prompt: {
    identity: 'You are a helpful AI assistant.',
    responseGuidelines: 'Be concise and informative.',
  },
  tools,
  auth: {
    // No `http` middleware here, so the chat routes under /api/chats answer 401 rather than serving anyone.
    ws: async req => {
      const token = req.headers.authorization;
      if (!token) return null;
      return {id: 'user-1'};
    },
  },
  orchestrator: {
    hooks: {
      afterModelResponse: async (_session, _responseText, usage) => {
        log.info('hooks', 'model response complete', {
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
        });
      },
    },
  },
  transport: {
    port: 8086,
    basePath: '/api',
  },
});

await engine.start();
// #endregion

// eslint-disable-next-line no-console
console.log('HAL Engine running on http://localhost:8086');
// eslint-disable-next-line no-console
console.log('Health check: http://localhost:8086/api/health');
// eslint-disable-next-line no-console
console.log('WebSocket: ws://localhost:8086/api/ws');
