# Adding a New Tool

Tools let the AI model fetch data or perform actions during a conversation. When the model decides it needs information (like weather data or a database lookup), it invokes a tool by name, the server executes it, and the result feeds back into the conversation.

Adding a new tool takes two steps: define it and register it. The rest is automatic -- the orchestrator passes tools to the AI provider, and the client already knows how to render any tool entry.

## Step 1: Create the tool file

Create a new file in `src/orchestration/tools/`. Each tool exports two things:

- A **`ToolDefinition`** describing the tool's name, purpose, and input schema
- A **`ToolExecutor`** function that runs the tool and returns a JSON string

Here is a complete example:

<!-- doc-block: none -- a complete worked tool for a fictional weather API, written to be copied and edited -->
```typescript
// src/orchestration/tools/weatherTool.ts

import type {ToolDefinition} from '../../types/ai.js';
import type {ToolExecutor} from './registry.js';

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
      /* eslint-disable camelcase */
      location: {
        type: 'string',
        description: 'The city name or location to look up.',
      },
      units: {
        type: 'string',
        enum: ['celsius', 'fahrenheit'],
        description: 'Temperature units. Defaults to celsius.',
      },
      /* eslint-enable camelcase */
    },
    required: ['location'],
  },
};

export const executeWeather: ToolExecutor = async (input) => {
  const location = (input.location as string) || 'Unknown';
  const units = (input.units as string) || 'celsius';

  // Replace with real API call
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
```

### Writing a good tool description

The `description` field is what the AI model reads to decide when to use the tool. Be specific:

- List the situations where the tool should be used ("Use this tool when...")
- Describe what the tool returns
- Give example queries if it helps

The more precise the description, the better the model's judgment about when to invoke it.

### Adding prompt instructions

The optional `promptInstructions` field provides guidance that gets included in the AI's system prompt. Unlike `description` (which is part of the tool schema sent to the AI provider), `promptInstructions` appears in the system prompt text itself, giving higher-level behavioral rules about when and how to use the tool.

<!-- doc-block: none -- one field of a ToolDefinition, quoted to discuss how to word it -->
```typescript
promptInstructions:
  'Use this when users ask about weather at a specific location. ' +
  'Call this for questions like "What is the weather in Berlin?" or "Is it raining in Tokyo?"',
```

The `ToolRegistry.getPromptInstructions()` method collects these from all registered tools, and the `PromptBuilder` assembles them into the system prompt automatically. If you don't provide `promptInstructions`, the tool still works -- it just won't have explicit guidance in the system prompt.

Use `promptInstructions` for:
- Short, actionable rules about when to call the tool
- Critical behavioral constraints (e.g., "MUST call this for every weather question")
- Example queries that help the model match user intent

Don't duplicate what's already in `description` -- keep `promptInstructions` focused on behavioral rules rather than describing inputs/outputs.

### Adding example prompts

The optional `examplePrompts` field provides example queries that are shown to users in the chat interface as clickable suggestions. These are sent to the client in the WebSocket `connected` message and persist throughout the conversation.

<!-- doc-block: none -- one field of a ToolDefinition, quoted to discuss how to word it -->
```typescript
examplePrompts: ['What is the weather in Berlin?', 'Is it raining in Tokyo?'],
```

The `ToolRegistry.getExamplePrompts()` method collects and flattens these from all registered tools. They are computed once at server startup and included in every new WebSocket connection's `connected` message.

Guidelines:
- Write prompts as natural user questions, not technical descriptions
- Keep them short and specific -- they appear as pill-shaped buttons in the UI
- 1-2 prompts per tool is enough; the total across all tools should stay manageable
- Use realistic terminology relevant to your application domain

### Defining the input schema

The `inputSchema` follows [JSON Schema](https://json-schema.org/) format. The model uses this to construct the correct input.

- Use `required` to mark mandatory fields
- Add `description` to each property -- the model reads these
- Tool parameter names use `snake_case` (this is the convention from the AI provider API, wrap them in `/* eslint-disable camelcase */` comments)

### Writing the executor

A `ToolExecutor` is an async function that takes the tool input and returns either a string or a `ToolResponse`:

<!-- doc-block: src/orchestration/tools/registry.ts#ToolExecutor -->
```typescript
type ToolExecutor = (input: Record<string, unknown>, context?: ToolContext) => Promise<string | ToolResponse>;
```

The optional `context` provides `userId`, `sessionId`, `workspaceId`, and `authHeaders` for tools that need to make authenticated API calls.

- Return `JSON.stringify(result)` for most tools -- the result gets added to the conversation as a tool result message
- Cast input fields from `unknown` to their expected types
- Handle missing or unknown input gracefully (return a reasonable default or error message)

For tools that need to send messages directly to the client or suppress the AI's echo, return a `ToolResponse` object instead of a plain string. See [tool-responses.md](../specs/hal-engine-tool-responses/spec.md) for a full walkthrough.

## Step 2: Register the tool

Open `src/orchestration/tools/index.ts` and add two lines:

<!-- doc-block: none -- the registration call for the fictional tool defined earlier in this document -->
```typescript
import {weatherTool, executeWeather} from './weatherTool.js';

// ... existing registrations ...

toolRegistry.register(weatherTool, executeWeather);
```

That is it. The `ToolRegistry` feeds all registered tool definitions to the chat orchestrator, which passes them to the AI provider. When the model invokes the tool, the registry looks up the executor by name and runs it.

## What happens automatically

Once a tool is registered, the following work without any additional code:

**On the backend:**

- `toolRegistry.getExamplePrompts()` collects example prompts from all tools and includes them in the WebSocket `connected` message
- `chatOrchestrator.ts` calls `toolRegistry.getPromptInstructions()` to include tool guidance in the system prompt via `PromptBuilder`
- `chatOrchestrator.ts` calls `toolRegistry.getDefinitions()` to pass all tools to the AI provider
- When the provider returns a `tool_use` chunk, the message handler creates a `ToolEntry` and sends it via `entry_upsert`
- The orchestrator executes all pending tool calls in parallel with `Promise.all()`
- Tool results are added to the conversation, and the provider is re-queried (up to `maxToolRounds` rounds)

**On the client:**

- Tool entries can be rendered by the client using the `toolName` and `toolInput` fields
- `formatToolName()` strips common prefixes (`get_`, `calculate_`, `fetch_`, `find_`) and title-cases the remaining words. So `get_weather` becomes **Weather**
- `formatParamName()` converts `snake_case` parameter names to Title Case for display. So `wind_speed` becomes **Wind Speed**
- A spinner shows on the last tool entry until a subsequent entry arrives

## File reference

| File | What it contains |
|------|-----------------|
| `src/types/ai.ts` | `ToolDefinition` interface (includes `promptInstructions`, `examplePrompts`) |
| `src/orchestration/tools/registry.ts` | `ToolExecutor` type, `ToolResponse` interface, `ToolRegistry` class (includes `getPromptInstructions()`, `getExamplePrompts()`) |
| `src/orchestration/tools/index.ts` | Tool registration (add your import and `register()` call here) |
| `src/infrastructure/builders/promptBuilder.ts` | `PromptBuilder` class that assembles the system prompt from tool instructions |
| `src/orchestration/chatOrchestrator.ts` | Where tools are passed to the provider and executed |
