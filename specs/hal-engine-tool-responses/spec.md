# Tool Responses

| Field  | Value |
| ------ | ----- |
| Issue  | n/a   |
| Status | Draft |

By default, a tool executor returns a plain string that feeds back into the AI conversation. The client never sees the result -- it only sees the tool invocation (name and input parameters). This is fine for most tools, but sometimes a tool knows exactly what to show the user and does not need the AI to rephrase it.

The `ToolResponse` interface gives tools two additional capabilities:

1. **Client messages** -- send one or more WebSocket messages directly to the client
2. **Suppress the AI response** -- keep the model's reply in conversation context but hide it from the client

These are opt-in. Tools that return a plain string continue to work exactly as before.

## The ToolResponse Interface

<!-- doc-block: src/orchestration/tools/registry.ts#ToolResponse -->
```typescript
interface ToolResponse {
  result: string;
  clientMessages?: OutgoingMessage[];
  suppressAssistantResponse?: boolean;
}
```

| Field | Purpose |
|-------|---------|
| `result` | The string the AI model sees -- identical to what a plain-string executor returns |
| `clientMessages` | Optional array of `OutgoingMessage` values sent directly to the client via WebSocket |
| `suppressAssistantResponse` | When `true`, the AI's next text response still accumulates in `session.entries` for context continuity, but is not sent to the client |

A `ToolExecutor` can return either a plain `string` or a `ToolResponse`:

<!-- doc-block: src/orchestration/tools/registry.ts#ToolExecutor -->
```typescript
type ToolExecutor = (input: Record<string, unknown>, context?: ToolContext) => Promise<string | ToolResponse>;
```

`context` carries the session the call belongs to -- `userId`, `sessionId`, `workspaceId`, and the `authHeaders` forwarded from the WebSocket upgrade, so a tool can proxy the caller's credentials upstream.

The registry normalizes both forms internally via `normalizeToolResponse()`, so downstream code always sees a `ToolResponse`.

## When to Use This

**Client messages** make sense when the tool result is self-explanatory and the AI does not need to interpret it for the user. A unit conversion, a status update, a formatted data table -- these are cases where the tool knows the best presentation and the AI would just parrot the same information.

**Suppression** pairs naturally with client messages. If the tool already sent the answer to the client, the AI's follow-up ("The conversion result is 160.93 km") adds no value. Suppression hides that echo while keeping it in the conversation so the AI remembers the context for follow-up questions.

Use plain string returns (the default) when the AI needs to interpret or summarize the tool result for the user. Database lookups and search results are good examples -- the raw data benefits from the AI explaining it in context.

## Data Flow

```
Plain string:    executor returns "data"
                   -> normalizeToolResponse wraps to {result: "data"}
                   -> orchestrator feeds result to AI
                   -> AI responds, client sees the response

With client messages:
                 executor returns {result, clientMessages, suppressAssistantResponse}
                   -> orchestrator extracts .result for AI (unchanged)
                   -> orchestrator yields tool_result chunk carrying clientMessages
                   -> if suppress, orchestrator yields suppress_output chunk
                   -> messageHandler sends clientMessages to client
                   -> messageHandler blanks pre-tool assistant entries (entry_upsert with empty content)
                   -> messageHandler skips WebSocket sends for suppressed entries
                   -> messageHandler sends entry_skip for each new suppressed entry
                   -> suppressed entries still accumulate in session.entries
                   -> client adjusts incoming indices using tracked skip list
```

The key insight: suppressed entries are invisible to the client but visible to the AI. The conversation context stays intact, so the model can reference previous tool results even when the user did not see the AI's commentary on them.

## Example: Unit Converter

The `convert_units` tool demonstrates all three features: client messages, suppression, and index assignment. A conversion like "100 miles to kilometers" has a definitive answer -- the AI does not need to elaborate.

<!-- doc-block: none -- a simplified tool, marked simplified in its own first line -->
```typescript
// src/orchestration/tools/unitConverterTool.ts (simplified)

export const executeUnitConverter: ToolExecutor = async (input) => {
  const value = input.value as number;
  const fromUnit = (input.from_unit as string) || '';
  const toUnit = (input.to_unit as string) || '';

  const result = convert(value, fromUnit, toUnit);

  if (!result) {
    // Error case: return plain string so AI can explain the problem
    return JSON.stringify({error: `Cannot convert from "${fromUnit}" to "${toUnit}".`});
  }

  return {
    result: JSON.stringify({value, fromUnit, toUnit, converted: result.converted, formatted: result.formatted}),
    clientMessages: [
      {
        type: 'entry_upsert',
        index: 0,
        entry: {role: 'assistant', content: result.formatted, timestamp: new Date().toISOString(), isStreaming: false},
      },
    ],
    suppressAssistantResponse: true,
  };
};
```

Notice three things:

1. On success, the executor returns a `clientMessages` array with an `entry_upsert` containing the formatted result. The client receives this as an assistant entry. The `index` is set to `0` -- the orchestrator replaces it with the correct session index (see "Index assignment" below).

2. `suppressAssistantResponse: true` hides the AI's follow-up. The AI still receives the result string (so it has context for follow-ups), but the client does not see the AI echoing "100 miles equals 160.93 km."

3. On error, the executor returns a plain string. This lets the AI explain what went wrong in its own words -- "I could not convert miles to knots because they measure different things."

## Adding Client Messages

If the tool wants to send a custom message to the client, use `clientMessages`. Any valid `OutgoingMessage` type works -- `entry_upsert`, `entry_delta`, `entry_commit`, or `error`.

<!-- doc-block: none -- a worked executor showing one return shape, not code this package exports -->
```typescript
export const executeMyTool: ToolExecutor = async (input) => {
  const data = await fetchSomething(input);

  return {
    result: JSON.stringify(data),
    clientMessages: [
      {type: 'entry_upsert', index: 0, entry: {
        role: 'assistant' as const,
        content: formatData(data),
        timestamp: new Date().toISOString(),
        isStreaming: false,
      }},
    ],
  };
};
```

Client messages are forwarded to the WebSocket after index assignment. The client processes them through its existing message dispatch pipeline -- no client-side changes needed.

### Index assignment for entry_upsert

Tools do not have access to the session, so they cannot know the correct entry index. The orchestrator handles this automatically: any `entry_upsert` message in `clientMessages` gets its `index` replaced with the real value by appending the entry to the session. The tool can set `index` to any value -- it will be overwritten.

This means the entry also becomes part of the session's `entries` array, maintaining context continuity for the AI model.

## How It Works Under the Hood

### Orchestrator

After executing tool calls, `chatOrchestrator.ts` checks each `ToolResponse` for client messages and suppression flags:

<!-- doc-block: none -- the orchestrator fragment that normalises responses, quoted out of its function -->
```typescript
const responses = await Promise.all(
  pendingToolCalls.map(async (tc) => {
    const response = await toolRegistry.execute(tc.name, tc.input);
    return {tc, response};
  })
);

// Collect client messages from all tools
const clientMessages = responses.flatMap(({response}) => response.clientMessages ?? []);

// Yield them as a chunk for the message handler
if (clientMessages.length > 0) {
  yield {type: 'tool_result', clientMessages};
}

// Signal suppression if any tool requested it
if (responses.some(({response}) => response.suppressAssistantResponse)) {
  yield {type: 'suppress_output'};
}
```

### Message Handler

Two new chunk types flow through `processChunk`:

- `tool_result` -- each client message in the array is serialized and sent directly to the WebSocket
- `suppress_output` -- sets `state.suppressOutput = true` on the stream state

When suppression is active, `streamSegment` and `commitAndClear` still call `appendEntry`, `appendDelta`, and `commitEntry` (so the session accumulates entries for context), but skip `sendUpsert`, `sendDelta`, and `sendCommit` (so the client sees nothing).

When a new entry is created under suppression, the server sends an `entry_skip` message with the server-side index. This tells the client "an entry exists here on the server, but you will never receive it." The client tracks these skipped indices and adjusts all subsequent incoming indices via the `adjustIndex` pure function. Without this, server indices would diverge from the client's entry array, causing deltas and commits to target the wrong positions.

If the AI streamed text *before* the tool call (which happens when the model explains what it is about to do), that text was already sent to the client as an assistant entry. When suppression activates, the server retroactively blanks these entries by sending `entry_upsert` with empty content. The client already skips rendering empty assistant entries, so the pre-tool text disappears cleanly.

**Suppression is sticky for the entire stream.** Once a tool sets `suppressAssistantResponse: true` in any round, all subsequent AI responses in that stream are suppressed -- even if later tool rounds do not set the flag. This is intentional: suppression is a per-message property, not per-round. If the first tool already sent the definitive answer to the client, the AI's commentary in all following rounds is equally redundant. A new user message starts a fresh stream with `suppressOutput: false`.

### stream_end and the spinner

The server sends a `stream_end` message after every completed stream (see [websocket-protocol.md](../hal-engine-websocket-protocol/spec.md)). This is the client's signal to clear loading indicators.

Without `stream_end`, suppression would cause the tool spinner to hang forever. When the assistant response is suppressed, no `entry_upsert` arrives after the tool entry, so the tool stays as the last entry in the array. The client tracks an `isProcessing` state: `true` when the user sends a message, `false` when `stream_end` arrives. The spinner only shows when the tool is both last in the list *and* the stream is still processing.

### MessageChunk union

The `MessageChunk` type gained two variants:

<!-- doc-block: src/types/ai.ts#MessageChunk -->
```typescript
type MessageChunk =
  | {type: 'text'; text: string}
```

These two variants are internal plumbing -- they never leave the server. The client only sees standard `OutgoingMessage` types over the WebSocket.

## File Reference

| File | What changed |
|------|-------------|
| `src/orchestration/tools/registry.ts` | `ToolResponse` interface, widened `ToolExecutor`, `normalizeToolResponse()` |
| `src/types/ai.ts` | `tool_result` and `suppress_output` variants on `MessageChunk` |
| `src/orchestration/chatOrchestrator.ts` | `executeToolCalls` returns `ToolExecutionResult`, yields new chunks |
| `src/transport/ws/messageHandler.ts` | `suppressOutput` on stream state, `processToolResultChunk`, guarded sends, `entry_skip`, blanking |
