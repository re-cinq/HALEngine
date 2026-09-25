// The worked tool from docs/adding-a-tool.md, as a file the compiler checks.

// #region weather-tool
import type {ToolDefinition, ToolExecutor} from '../src/index.js';

export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description:
    'Get the current weather for a location.\n\n' +
    'Use this tool when the user:\n' +
    '* Asks about weather or temperature\n' +
    '* Wants to know conditions at a specific place\n' +
    '* Needs a forecast for planning\n\n' +
    'Returns temperature, conditions, humidity, and wind speed.',
  promptInstructions:
    'Use this when users ask about weather at a specific location. ' +
    'Call this for questions like "What is the weather in Berlin?" or "Is it raining in Tokyo?"',
  examplePrompts: ['What is the weather in Berlin?', 'Is it raining in Tokyo?'],
  inputSchema: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'The city name or location to look up.',
      },
      units: {
        type: 'string',
        enum: ['celsius', 'fahrenheit'],
        description: 'Temperature units. Defaults to celsius.',
      },
    },
    required: ['location'],
  },
};

export const executeWeather: ToolExecutor = async input => {
  const location = input.location as string;
  const units = (input.units as string) ?? 'celsius';

  // Replace with a real API call. `location` has already passed the declared inputSchema.
  const result = {
    location,
    temperature: 18,
    units,
    conditions: 'Partly cloudy',
    humidity: 65,
    windSpeed: 12,
    windUnit: 'km/h',
  };

  return JSON.stringify(result);
};
// #endregion
