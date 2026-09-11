# Coding Practices

This document captures the conventions and principles that guide how code is written in this project. They are not arbitrary style rules -- they come from real patterns already established in the codebase. Each practice includes an explanation of *why* it matters and what you gain by following it.

## The 4 Rules of Simple Design

These are listed in priority order. When two rules conflict, the higher one wins.

1. **Passes all tests** -- the code must work correctly. A beautiful design that fails tests is worthless. This is rule number one because nothing else matters if the software does not do what it is supposed to do.

2. **Reveals intention** -- code clearly expresses what it does. A reader should understand the *why*, not just the *how*. When code reveals intention, new team members can onboard faster, bugs are easier to spot during review, and maintenance costs drop because developers spend less time deciphering what a piece of code is trying to accomplish.

3. **No duplication** -- every piece of knowledge has a single representation. DRY, but applied thoughtfully (not mechanically). Duplication means that a change in behavior requires updates in multiple places. Miss one, and you have a bug. Eliminating duplication forces you to find the right abstractions, which in turn makes the code easier to evolve.

4. **Fewest elements** -- remove anything that does not serve rules 1-3. No extra classes, methods, variables, or abstractions that don't pull their weight. Every line of code is a liability -- it must be read, understood, and maintained. Code that exists without a clear purpose adds cognitive load and creates places for bugs to hide.

These four rules form the foundation. Everything below is a concrete application of them.

## Architecture

### Extract pure functions outside of classes

Functions without side effects are easier to test, easier to read, and easier to compose. In this codebase, most logic lives in standalone functions, not class methods.

**Why this matters:** Pure functions can be tested without mocking dependencies, constructing objects, or managing setup/teardown. You call them with input and check the output. That is the entire test. No mocks to configure, no lifecycle to manage, no hidden state to worry about. It also makes the functions portable -- they can be imported anywhere without dragging along a class instance.

**Benefits:** Tests become refreshingly simple when there is nothing to mock. Functions move freely between modules because they carry no baggage. And reasoning about code gets easier when you can look at a function in isolation and know that it has no side effects lurking behind the scenes.

Examples from the codebase:

- `entryFactories.ts` -- `createUserEntry()`, `createAssistantEntry()`, `createToolEntry()`
- `entryMutations.ts` -- `appendEntry()`, `appendDelta()`, `commitEntry()`
- `orchestratorHelpers.ts` -- `shouldContinueToolLoop()`, `collectToolCalls()`, `extractStopReason()`

### Factory functions over classes

When there is no mutable state to encapsulate, use a factory function instead of a class. Classes are reserved for cases where state management is genuinely needed (like `ToolRegistry` with its internal `Map`, or `ThinkingTagParser` with its buffer).

**Why this matters:** Classes introduce ceremony -- constructors, `this` binding, inheritance chains. When all you need is to create a value or return an object with methods, a factory function does the same job with less indirection. It also sidesteps a classic JavaScript footgun: losing `this` context when methods are passed as callbacks.

**Benefits:** You get less boilerplate without the constructor and `this` dance. The return type becomes the interface rather than the class, so callers depend on behavior instead of implementation. And when the time comes to swap implementations, you just call a different factory -- no inheritance gymnastics required.

Examples:

- `createChatOrchestrator(provider, toolRegistry)` returns a `ChatOrchestrator` object
- `createUserEntry(content)` returns a `SessionEntry`
- `createContextConfig()` returns a config object

### Provider-agnostic interfaces

Business logic depends on interfaces, not implementations. The `AIProvider` interface is provider-agnostic -- Bedrock-specific code lives in isolation under `providers/bedrock/`, Vertex under `providers/vertex/`, and so on.

**Why this matters:** AI providers change. Today it is Bedrock, tomorrow it might be something else entirely. If the orchestrator, message handler, and test suite all depend on provider types directly, switching means rewriting everything. With an interface boundary, you write one new adapter and plug it in. The rest of the system never notices.

**Benefits:** Switching providers becomes a contained operation -- write a new adapter, done, no changes to business logic. Mock providers for testing are trivial to implement (see `providers/mock/`). And provider-specific quirks stay contained in one place rather than leaking across the codebase.

### Single-purpose functions

Each function does one thing. When a function starts handling multiple concerns, split it.

**Why this matters:** A function that does one thing is easy to name, easy to test, and easy to reuse. When a function does three things, its test needs to cover all combinations, its name becomes vague, and reusing part of its logic means copy-pasting. Single-purpose functions compose naturally -- you build complex behavior by calling simple functions in sequence, like words forming a sentence.

**Benefits:** Each function can be tested in isolation without worrying about interactions between concerns. Functions stay small enough to read and understand in seconds. And when a bug surfaces, the blast radius is small -- you know exactly which function to look at.

Example from `messageHandler.ts`:

- `initSegment()` -- creates a new entry in the session and returns whether it was newly created
- `streamSegment()` -- appends a delta to an entry and conditionally sends WebSocket messages
- `commitAndClear()` -- commits an entry and resets the state index
- `processTextChunk()` -- routes parsed segments to the right handler
- `processToolUseChunk()` -- creates a tool entry
- `processToolResultChunk()` -- forwards client messages to the WebSocket
- `processStopChunk()` -- flushes the parser and commits open entries

### No nested conditionals

Avoid nesting `if` statements inside each other. Use early returns, guard clauses, or extract functions to keep the nesting depth at one level.

**Why this matters:** Nested conditionals force the reader to hold multiple conditions in their head simultaneously. Each level of nesting multiplies the mental effort required to understand which path the code takes. Flat code with early returns reads top to bottom -- each condition is checked and dismissed before the main logic runs. It is the difference between navigating a maze and walking down a hallway.

**Benefits:** Code scans from top to bottom without indentation pyramids. Each condition is visible at the same level, making it easy to verify that all cases are handled. And when a new condition needs to be added, it slots in as another early return rather than wrapping everything in another layer of nesting.

```typescript
// Good: flat with early return
function streamSegment(ws: WebSocket, session: ChatSession, state: StreamState, ...): void {
  const isNew = initSegment(session, state, key, createEntry);
  if (!state.suppressOutput && isNew) sendUpsert(ws, state[key]!, session.entries[state[key]!]);
  appendDelta(session, state[key]!, content);
  if (!state.suppressOutput) sendDelta(ws, state[key]!, content);
}

// Bad: nested conditionals
function streamSegment(ws: WebSocket, session: ChatSession, state: StreamState, ...): void {
  if (state[key] === null) {
    state[key] = appendEntry(session, createEntry());
    if (!state.suppressOutput) {
      sendUpsert(ws, state[key]!, session.entries[state[key]!]);
    }
  }
  appendDelta(session, state[key]!, content);
  if (!state.suppressOutput) {
    sendDelta(ws, state[key]!, content);
  }
}
```

## Type Safety

### Never use `any`

Use `Record<string, unknown>` when the shape is truly dynamic (like tool input). Use specific types everywhere else. The eslint config enforces `@typescript-eslint/no-explicit-any: error`.

**Why this matters:** `any` disables the type checker for everything it touches. Worse, it spreads silently -- assign an `any` value to a typed variable and TypeScript stops checking that variable too. Bugs that the compiler would have caught at build time instead show up at runtime, in production, at 3 AM. One `any` can quietly undermine an entire module's type safety.

**Benefits:** The compiler catches type mismatches before code ever ships. Refactoring becomes safe because renaming a field surfaces every place that needs updating -- nothing slips through the cracks. And IDE autocomplete actually works, which makes developers faster and happier.

### Discriminated unions for message types

Use a `type` (or `role`) field as the discriminant. This gives you exhaustive checking in `switch` statements and clean narrowing.

**Why this matters:** When you add a new variant to a discriminated union, TypeScript flags every `switch` statement that does not handle it. This turns "did I forget to handle the new message type somewhere?" from a manual audit into a compiler error. You literally cannot forget -- the build will not let you.

**Benefits:** Adding a new variant produces compile-time errors at every unhandled location, so nothing is missed. TypeScript narrows the type inside each `case` branch automatically, so no casts are needed. And the union type itself becomes the single source of truth for "what kinds of X exist in this system?"

Examples:

- `SessionEntry` discriminated on `role`: `'user' | 'assistant' | 'thinking' | 'tool'`
- `MessageChunk` discriminated on `type`: `'text' | 'tool_use' | 'tool_result' | 'suppress_output' | 'stop'`
- `OutgoingMessage` discriminated on `type`: `'connected' | 'entry_upsert' | ...`
- `IncomingMessage` discriminated on `type`: `'user_message' | 'ping'`

### Validate at system boundaries

Validation happens once, at the point where external data enters the system. After that, trust the types.

**Why this matters:** Defensive checks scattered throughout the codebase create noise. Every `if (!x) throw` inside a handler is a line that a reader has to process and wonder "can this actually happen?" Validating at the boundary means the answer inside the boundary is always "no, it cannot." The code on the inside becomes cleaner, the intent clearer, and the trust in the type system well-founded.

**Benefits:** Internal code reads smoothly, free of defensive checks that break the flow. Validation logic lives in one place, making it consistent and easy to audit. And you only need to test validation once, at the boundary, instead of in every function that touches the data.

Where validation happens:

- `validateMessage()` validates incoming WebSocket messages in `src/transport/ws/validation.ts`
- Tool input is typed as `Record<string, unknown>` because it comes from the AI model

There is no defensive validation deep inside handlers -- if the data made it past the boundary, it is safe.

## State Management

### Immutable updates

Frontend state is never mutated. The entry operations (`applyUpsert`, `applyDelta`, `applyCommit`) all return new arrays.

**Why this matters:** React relies on reference equality to decide whether to re-render. If you mutate an array in place, React does not see a change and the UI goes stale. Returning new arrays makes state changes explicit, predictable, and visible to React. It also makes debugging a pleasure rather than a puzzle -- you can compare previous and current state without worrying that one was modified after the fact.

**Benefits:** React re-renders correctly every time, without surprises. State changes are traceable because previous state is never overwritten. And time-travel debugging becomes possible, letting you step through state transitions to understand exactly how the UI arrived at its current shape.

```typescript
// Good: returns new array
function applyUpsert(entries: SessionEntry[], index: number, entry: SessionEntry): SessionEntry[] {
  const result = [...entries];
  result[index] = entry;
  return result;
}

// Bad: mutates in place
function applyUpsert(entries: SessionEntry[], index: number, entry: SessionEntry): void {
  entries[index] = entry;  // don't do this
}
```

### Optimistic UI updates

When a user sends a message, the entry appears in the UI immediately -- before the server confirms it. The server later sends an `entry_upsert` that replaces the optimistic entry with the canonical one.

**Why this matters:** Network round-trips add latency. If the UI waits for the server before showing the user's own message, the chat feels sluggish. Optimistic updates make the interface feel instant. The user types, presses send, and sees their message right there -- no spinner, no delay, no waiting for a server on the other side of the world to say "yes, I got it."

**Benefits:** The chat feels responsive regardless of network conditions. Users see their message immediately, which builds confidence that the system is working. And eventual consistency is maintained because the server confirmation still arrives and quietly replaces the optimistic entry with the real one.

## Async Patterns

### AsyncGenerator for streaming

The AI provider streams chunks via `AsyncGenerator<MessageChunk>`. This is composable (the orchestrator `yield`s chunks to the message handler) and provider-agnostic (any provider can implement the same interface).

**Why this matters:** Streaming responses arrive piece by piece. Without a structured streaming primitive, you end up with callbacks, event emitters, or manual buffer management -- all of which are harder to read and harder to compose. AsyncGenerator gives you a clean `for await...of` loop that reads like synchronous code but handles asynchronous chunks gracefully. The orchestrator yields to the handler, which yields to the WebSocket, and none of them need to know about each other.

**Benefits:** Code reads like a simple loop despite being fully asynchronous. Streaming pipelines compose naturally as generators yield to generators, forming a clean chain from AI provider to browser. And back-pressure is handled automatically because the consumer controls the pace -- no buffer overflow surprises.

```typescript
async *processMessageStream(session: ChatSession): AsyncGenerator<MessageChunk> {
  for await (const chunk of provider.sendMessage({messages, systemPrompt, tools})) {
    yield chunk;
  }
}
```

### Parallel execution with Promise.all

When multiple independent operations need to happen, run them in parallel. Tool calls are a clear example -- the orchestrator executes all pending tool calls simultaneously.

**Why this matters:** If you have 3 tool calls that each take 200ms, running them sequentially takes 600ms. Running them in parallel takes 200ms. For a user waiting on a chat response, that 400ms difference is the difference between "snappy" and "sluggish." Parallelism is free performance -- you just have to reach for it.

**Benefits:** Total latency equals the slowest operation rather than the sum of all of them. Server resources are utilized more efficiently because work happens concurrently. And the pattern scales beautifully -- whether you have 2 operations or 20, the wall-clock time stays bounded by the single slowest one.

```typescript
const results = await Promise.all(
  pendingToolCalls.map(async (tc) => ({
    type: 'tool_result',
    toolUseId: tc.id,
    content: await toolRegistry.execute(tc.name, tc.input),
  }))
);
```

### No sequential await in loops

If loop iterations are independent, do not `await` each one. Collect the promises and resolve them together.

**Why this matters:** Sequential awaits in a loop are one of the most common performance mistakes in async JavaScript. Each iteration blocks until the previous one finishes, even when the operations have no dependency on each other. This turns what could be O(1) parallel work into O(N) sequential work -- and the penalty grows linearly with the number of iterations.

**Benefits:** The speedup is dramatic and immediate for loops with independent async operations. And the pattern serves as documentation of intent -- `Promise.all` signals "these are independent" while sequential `await` signals "these must be ordered."

## Testing

### No "should" in test names

Test names describe what happens, not what should happen.

**Why this matters:** "Should" adds a word to every test name without adding information. It also creates a subtle framing issue -- "should return X" reads as aspirational, like a wish. "Returns X" reads as factual, like a specification. Test names are documentation of how the system behaves. They should state facts, not hopes.

**Benefits:** Test names are shorter and scan faster in the test runner output. Reading the test suite feels like reading a specification of system behavior. And the naming convention stays consistent across the codebase, making it easy to follow the pattern when writing new tests.

```typescript
// Good
it('returns empty state when no entries', () => { ... });
it('strips get_ prefix and capitalizes words', () => { ... });

// Bad
it('should return empty state when no entries', () => { ... });
it('should strip get_ prefix', () => { ... });
```

### Test names use tested data and expected outcome

The name should read naturally as a sentence when combined with the `it()` call.

**Why this matters:** When a test fails, the first thing you see is its name. A name like "returns 14:30 for timestamp 2024-01-15T14:30:00" tells you exactly what broke without opening the test file. A generic name like "handles timestamps correctly" tells you nothing -- you have to dig into the code to understand what went wrong and what was expected.

**Benefits:** Failed tests are immediately understandable from the test runner output alone. The test suite doubles as living documentation of edge cases and expected behavior. And writing new tests is easy because the naming pattern is clear -- describe the input, describe the output.

```typescript
it('formats timestamp 2024-01-15T14:30:00 as "14:30"', () => { ... });
it('caps delay at max value', () => { ... });
it('sends all queued messages and returns empty array', () => { ... });
```

### Use toEqual / toMatchObject over multiple assertions

Instead of checking individual fields one by one, assert the whole shape.

**Why this matters:** Multiple individual assertions obscure the overall shape of what you are testing. If you check `role`, then `content`, then `isStreaming` separately, a reader has to mentally assemble the expected object from scattered pieces. `toMatchObject` shows the expected shape in one place, as a single coherent picture. It also catches unexpected changes -- if a field you did not explicitly check changes in a breaking way, `toEqual` catches it while individual assertions silently miss it.

**Benefits:** The expected shape is visible at a glance as a single object literal. Test code is shorter and more focused. And `toEqual` catches unexpected field changes that a series of individual `.toBe()` checks would happily overlook.

```typescript
// Good
expect(result[0]).toMatchObject({role: 'assistant', content: 'Hello world', isStreaming: false});

// Bad
expect(result[0].role).toBe('assistant');
expect(result[0].content).toBe('Hello world');
expect(result[0].isStreaming).toBe(false);
```

### Skip redundant existence checks

If you are checking a value with `.toMatch()` or `.toMatchObject()`, a separate `.toBeDefined()` check adds nothing.

**Why this matters:** Redundant assertions are noise. If `toMatchObject` passes, the value is obviously defined -- there is no scenario where an undefined value matches a concrete object. The extra check does not catch any additional failure case. It just makes the test longer and clutters the signal with meaningless assertions.

**Benefits:** Tests stay short and focused on what actually matters. Less noise means that when a test does fail, the reason is immediately clear without wading through assertions that could never have caught the problem.

## Code Style

### No unnecessary comments

If the code needs a comment to explain what it does, rename things until it doesn't. Comments are reserved for explaining *why* something non-obvious exists, not *what* the code does.

**Why this matters:** Comments that restate the code ("create a user entry" above `createUserEntry()`) are pure noise. Worse, they go stale -- the code changes but the comment does not, and now there is a lie sitting in the codebase, patiently misleading the next person who reads it. Comments that explain *why* are valuable precisely because the "why" is invisible in the code itself -- it lives in the context of a decision, a workaround, or a constraint.

**Benefits:** Readers encounter less noise and can focus on the code itself. Stale comments never mislead future developers because there are no unnecessary comments to go stale. And the constraint forces better naming, which benefits everyone who reads the code long after the comment would have been forgotten.

```typescript
// Unnecessary comment:
// Create a user entry
const userEntry = createUserEntry(content);

// Useful comment:
// TODO: Replace stub with real weather API lookup
export const executeWeather: ToolExecutor = async (input) => { ... };
```

### Descriptive variable names

Names carry meaning. Prefer `thinkingIndex` over `idx`, `pendingToolCalls` over `calls`, `isStreaming` over `streaming`.

**Why this matters:** You read code far more often than you write it. A descriptive name saves every future reader the effort of figuring out what a variable represents from context. Short, cryptic names save a few keystrokes for the author and cost minutes for every reader who encounters them later. The trade-off is not even close.

**Benefits:** Code is understandable on its own without scrolling up to see what `idx` was assigned to three screens ago. Grep and find-and-replace work reliably on specific, unique names. And code reviews move faster because the intent is obvious from the names alone.

### Inline single-use helpers

If a helper function is called exactly once and its name does not add clarity beyond the code itself, inline it. Abstractions earn their place by being reused or by making complex logic readable -- not by existing.

**Why this matters:** Every function is an indirection -- a jump from "here" to "over there." That jump is worth it when it gives you a meaningful name for a complex operation, or when it eliminates duplication. But a single-use helper that wraps a straightforward operation just sends the reader on a detour to understand what could have been read in place.

**Benefits:** Fewer files and functions to navigate means less cognitive overhead. Logic is visible right where it is used, not hidden behind a name in another file. And this practice aligns directly with Rule 4 -- fewest elements. If it does not earn its place, it does not need to exist.

## Database and Performance

### Minimize queries

Avoid redundant database lookups. If you already have an object, pass it directly instead of passing an ID and re-fetching.

**Why this matters:** Database queries are among the most expensive operations in a web application. Each round-trip adds latency and load. When a function already has the data it needs, passing an ID and re-fetching that same data from the database is pure waste -- the information made the trip for nothing.

**Benefits:** Users experience lower latency because unnecessary round-trips are eliminated. The database handles less load, which matters under concurrency. And function signatures become simpler -- you pass the thing itself rather than a key to look it up again.

### Use transactions only when needed

Transactions add overhead and reduce concurrency. Use them where data integrity requires atomicity (multiple writes that must succeed or fail together), not as a default wrapper.

**Why this matters:** Transactions hold locks. The longer a transaction runs, the more other operations wait. Wrapping every database call in a transaction "just in case" creates unnecessary contention and makes the system slower under load. Transactions are a tool for correctness, not a safety blanket.

**Benefits:** Higher throughput under concurrent load because operations that do not need atomicity are not blocking each other. Lower latency for simple reads and writes that can run independently. And explicit transaction boundaries make it clear exactly where data integrity is critical -- they become meaningful markers in the code rather than boilerplate noise.
