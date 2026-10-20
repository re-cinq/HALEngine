# Tool Responses

| Field  | Value       |
| ------ | ----------- |
| Issue  | n/a         |
| Status | In Progress |

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
  /** Tells the model `result` describes a failure, not an answer; each provider's encoding is in specs/hal-engine-tool-responses/spec.md. */
  isError?: boolean;
}
```

| Field | Purpose |
|-------|---------|
| `result` | The string the AI model sees -- identical to what a plain-string executor returns |
| `clientMessages` | Optional array of `OutgoingMessage` values sent directly to the client via WebSocket |
| `suppressAssistantResponse` | When `true`, the AI's next text response still accumulates in `session.entries` for context continuity, but is not sent to the client |
| `isError` | When `true`, `result` describes a failure, and the provider is told so on its own wire; see [Marking a failure](#marking-a-failure-iserror) |

A `ToolExecutor` can return either a plain `string` or a `ToolResponse`:

<!-- doc-block: src/orchestration/tools/registry.ts#ToolExecutor -->
```typescript
type ToolExecutor = (input: Record<string, unknown>, context?: ToolContext) => Promise<string | ToolResponse>;
```

`context` carries the session the call belongs to -- `userId`, `sessionId`, `workspaceId`, and the `authHeaders` forwarded from the WebSocket upgrade, so a tool can proxy the caller's credentials upstream. It also carries a `signal` of its own, aborted when the orchestrator abandons the call at its `toolTimeoutMs` deadline.

An executor that throws is caught: the model is told the call failed, and the thrown message reaches only the log, as [tool-executor-throw](../hal-engine-tool-executor-throw/spec.md) specifies.

The registry normalizes both forms internally via `normalizeToolResponse()`, so downstream code always sees a `ToolResponse`.

## Marking a failure: isError

A tool signals that a call failed by returning `isError: true` beside its `result`, a single bit rather than a taxonomy: a kind of failure stays in the `result` text, where the model reads it. The flag never reaches the browser wire.

- `normalizeToolResponse` turns a plain string into `{result}` with no `isError` key, so a tool that returns a string sees no change ([validated by: normalizes '18 degrees and clear' to {result} with no isError key](../../src/orchestration/toolResultError.test.ts#L53)).
- A `ToolResponse` with `isError: true` reaches the provider's next call as a `tool_result` carrying `isError: true` ([validated by: carries isError true from an executor's {result: 'lookup failed', isError: true} onto the tool_result the provider's next call gets](../../src/orchestration/toolResultError.test.ts#L62)).
- A successful result carries no `isError` key at all, so it reaches the provider exactly as it did before the field existed ([validated by: sends a successful result with no isError key at all, as before the field existed](../../src/orchestration/toolResultError.test.ts#L68)).
- The engine marks a schema rejection as an error ([validated by: marks a schema rejection as an error: lookup called without its required id](../../src/orchestration/toolResultError.test.ts#L77)).
- It marks its answer to a tool name the model invented as an error ([validated by: marks the answer to an unknown tool name as an error: lookpu, a name the model invented](../../src/orchestration/toolResultError.test.ts#L81)).
- It marks the result it substitutes at a call's deadline as an error ([validated by: marks the deadline substitution as an error: lookup never answering within toolTimeoutMs 5](../../src/orchestration/toolResultError.test.ts#L85)).
- It marks a call declined because its `beforeToolCall` policy threw as an error ([validated by: marks a declined call as an error: a beforeToolCall policy that throws](../../src/orchestration/toolResultError.test.ts#L89)).
- It marks the result it gives for an executor that threw as an error ([validated by: marks a caught executor throw as an error: lookup rejecting with ECONNREFUSED](../../src/orchestration/toolResultError.test.ts#L97)).
- Bedrock encodes the flag as the Converse API's `toolResult.status: 'error'` ([validated by: maps a tool_result with isError true to a toolResult whose status is 'error'](../../src/providers/bedrock/bedrockMessageMapper.test.ts#L8)).
- A Bedrock result without the flag carries no `status` key at all ([validated by: maps the same tool_result with isError omitted to a toolResult with no status key](../../src/providers/bedrock/bedrockMessageMapper.test.ts#L17)).
- The Bedrock mapper writes the literal `'error'`, not the SDK's `ToolResultStatus.ERROR`, because that constant is a value import, and the module imports the optional peer as types only ([validated by: imports @aws-sdk/client-bedrock-runtime as types only, so the optional peer is never loaded by mapping](../../src/providers/bedrock/bedrockMessageMapper.test.ts#L27)).
- Vertex has no status field, so a failure travels as `functionResponse.response.error` in place of `response.result`, and a success is unchanged ([validated by: sends a failed tool_result under functionResponse.response.error and a successful one under response.result](../../src/providers/vertex/vertexProvider.test.ts#L444)).

Bedrock's own note on `toolResult.status`, as `@aws-sdk/client-bedrock-runtime` 3.1020.0 documents it: "This field is only supported by Amazon Nova and Anthropic Claude 3 and 4 models." Other Bedrock models get the same failure text in `result` without the status. The mock provider maps no tool result at all, so it has nothing to encode.

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

After executing tool calls, `chatOrchestrator.ts` checks each `ToolResponse` for client messages and suppression flags. `executeToolCalls` runs every call through `runToolCall`, which applies a `beforeToolCall` policy and the call's deadline, and returns what the round asked of the client; the tool loop then yields it to the message handler:

<!-- doc-block: none -- two orchestrator fragments, quoted out of their functions -->
```typescript
// executeToolCalls
const responses = await Promise.all(
  pendingToolCalls.map(async tc => {
    const response = await runToolCall(tc);
    return {tc, response};
  })
);
// … each response's result becomes its call's tool_result for the next provider call …
const rawClientMessages = responses.flatMap(({response}) => response.clientMessages ?? []);

return {
  clientMessages: assignEntryIndices(rawClientMessages, session),
  suppressOutput: responses.some(({response}) => response.suppressAssistantResponse === true),
};

// the tool loop
if (clientMessages.length > 0) {
  yield {type: 'tool_result' as const, clientMessages};
}

if (suppressOutput) {
  yield {type: 'suppress_output' as const};
}
```

### Message Handler

Two new chunk types flow through `processChunk`:

- `tool_result` -- each client message in the array is serialized and sent directly to the WebSocket
- `suppress_output` -- sets `state.suppressOutput = true` on the stream state

When suppression is active, `streamSegment` and `commitAndClear` still call `appendEntry`, `appendDelta`, and `commitEntry` (so the session accumulates entries for context), but skip `sendUpsert`, `sendDelta`, and `sendCommit` (so the client sees nothing).

Three rules decide what the client receives once suppression is active:

- **A model entry already sent is blanked.** Every thinking or assistant entry the client was sent before suppression began, including text the model streamed before the tool call to explain what it was about to do, is re-sent as `entry_upsert` with empty content, and the stored entry keeps its text, marked `suppressed` ([validated by: blanks a thinking entry already sent beside the answer, and no frame after suppression carries its text](../../src/transport/ws/messageHandler.test.ts#L196), [validated by: marks a blanked thinking entry suppressed beside the blanked answer, keeping both texts](../../src/transport/ws/messageHandler.test.ts#L271)).
- **A model entry not yet sent is skipped.** A thinking or assistant entry opened under suppression is announced with `entry_skip` carrying its server-side index: an entry exists here on the server, but the client will never receive it. The client tracks these skipped indices and adjusts every later incoming index with the `adjustIndex` pure function; without this, server indices would diverge from the client's entry array, and deltas and commits would target the wrong positions ([validated by: skips rather than upserts a segment opened after suppression](../../src/transport/ws/messageHandler.test.ts#L219), [validated by: skips a thinking entry opened after suppression rather than blanking it](../../src/transport/ws/messageHandler.test.ts#L325)).
- **A tool entry is exempt from both.** It is no model response, and hiding it under sticky suppression would leave the client nothing between the tool's answer and `stream_end`, which the spinner logic below relies on, so it is sent as `entry_upsert` with its `toolName` and `toolInput` ([validated by: still sends a tool entry opened under suppression as an entry_upsert carrying its toolName and toolInput](../../src/transport/ws/messageHandler.test.ts#L333)).

The blanking is logged once, at `info`, as `suppression activated` with the blanked indices and nothing else, since their text is exactly what suppression hides ([validated by: lists thinking index 1 and assistant index 2 at suppression, and no line carries their text](../../src/transport/ws/messageHandler.test.ts#L355)).

Suppression is recorded on the stored entry, so a conversation resumed from a store replays a suppressed entry as `entry_skip`, never as its text ([validated by: replays a suppressed entry as a skip, so the client never sees text a tool suppressed](../../src/transport/sessionResume.test.ts#L335)).

**Suppression is sticky for the entire stream.** Once a tool sets `suppressAssistantResponse: true` in any round, all subsequent AI responses in that stream are suppressed -- even if later tool rounds do not set the flag. This is intentional: suppression is a per-message property, not per-round. If the first tool already sent the definitive answer to the client, the AI's commentary in all following rounds is equally redundant. A new user message starts a fresh stream with `suppressOutput: false`.

### stream_end and the spinner

The server sends a `stream_end` message after every stream, including one that failed after an `error` frame (see [websocket-protocol.md](../hal-engine-websocket-protocol/spec.md)). This is the client's signal to clear loading indicators, so a failed stream clears the spinner the same way a completed one does.

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
