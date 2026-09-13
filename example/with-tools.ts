// The getting-started tool example, as a file the compiler checks.

// #region with-tools
import {createHalEngine, ToolRegistry} from '../src/index.js';
import type {ToolDefinition} from '../src/index.js';

const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Get current weather for a location.',
  inputSchema: {
    type: 'object',
    properties: {
      location: {type: 'string', description: 'City name'},
    },
    required: ['location'],
  },
};

async function executeWeather(input: Record<string, unknown>): Promise<string> {
  const location = input.location as string;
  const weather = await fetchWeatherApi(location);
  return JSON.stringify(weather);
}

const toolRegistry = new ToolRegistry();
toolRegistry.register(weatherTool, executeWeather);

const engine = createHalEngine({
  provider: {
    type: 'bedrock',
    region: 'eu-west-1',
    modelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    maxTokens: 4096,
  },
  prompt: {
    identity: 'You are a helpful weather assistant.',
    responseGuidelines:
      'Always use the get_weather tool when asked about weather. Present temperatures in the units the user prefers.',
  },
  tools: toolRegistry,
  auth: {
    ws: async req => verifyToken(req.headers.authorization),
  },
});
// #endregion

void engine;

// Below the region on purpose: a reader copying the snippet supplies these. Function declarations hoist.
interface Weather {
  location: string;
  celsius: number;
  summary: string;
}

async function fetchWeatherApi(location: string): Promise<Weather> {
  return {location, celsius: 22, summary: 'partly cloudy'};
}

async function verifyToken(authorization: string | undefined): Promise<{id: string} | null> {
  if (!authorization) return null;

  return {id: 'user-1'};
}
