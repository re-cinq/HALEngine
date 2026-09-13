# Adding a New Message Type

This guide covers how to add new WebSocket message types. There are two directions to consider:

- **Server to client** -- the backend sends a new kind of message to the client
- **Client to server** -- the client sends a new kind of message to the backend

Each direction has its own set of files to touch. If your new message type also introduces a new **entry type** (a new role in the conversation, like `user`, `assistant`, `thinking`, or `tool`), there are additional steps at the end.

## Adding a Server-to-Client Message

This is the more common case. The backend needs to push something new to the client.

### 1. Define the message type on the backend

Open `src/types/messages.ts` and add a new interface, then include it in the `OutgoingMessage` union:

<!-- doc-block: none -- a StatusUpdateMessage this document invents to demonstrate the steps; it is not a type this package declares -->
```typescript
export interface StatusUpdateMessage {
  type: 'status_update';
  status: string;
}

export type OutgoingMessage =
  | ConnectedMessage
  | EntryUpsertMessage
  | EntryDeltaMessage
  | EntryCommitMessage
  | EntrySkipMessage
  | ErrorMessage
  | PongMessage
  | StreamEndMessage
  | StatusUpdateMessage;    // add here
```

### 2. Create a sender helper

Open `src/transport/ws/sender.ts` and add a function that sends the message:

<!-- doc-block: none -- a sender for the invented message type -->
```typescript
export function sendStatusUpdate(ws: WebSocket, status: string): void {
  ws.send(JSON.stringify({type: 'status_update', status}));
}
```

### 3. Send it from the handler

In `src/transport/ws/messageHandler.ts` (or wherever the event originates), call the sender:

<!-- doc-block: none -- a call site for the invented message type -->
```typescript
sendStatusUpdate(ws, 'processing');
```

### 4. Handle it on the client

On the client side, add the type to your message union and handle it in your message dispatch:

<!-- doc-block: none -- the client-side half of the invented message type -->
```typescript
interface StatusUpdateMessage {
  type: 'status_update';
  status: string;
}

// Add to your server message union type
// Handle in your message dispatch switch/if
```

That completes a server-to-client message. The backend can now send it, and the client will receive and handle it.

---

## Adding a Client-to-Server Message

Less common, but sometimes the client needs to send new kinds of messages to the backend.

### 1. Define the message type on the backend

Open `src/types/messages.ts` and add to the `IncomingMessage` union:

<!-- doc-block: none -- a StopGenerationPayload this document invents to demonstrate the steps -->
```typescript
export interface StopGenerationPayload {
  type: 'stop_generation';
}

export type IncomingMessage = UserMessagePayload | PingMessage | StopGenerationPayload;
```

### 2. Add validation

Open `src/transport/ws/validation.ts` and add a case to the switch:

<!-- doc-block: none -- the validation switch with an invented case added, shown as a diff against the real one -->
```typescript
switch (message.type) {
  case 'user_message':
    return validateUserMessage(message);
  case 'ping':
    return validatePingMessage(message);
  case 'stop_generation':    // add here
    return {valid: true, data: {type: 'stop_generation'}};
  default:
    return {valid: false, error: `Unknown message type: ${message.type}`};
}
```

### 3. Handle it in the message handler

Open `src/transport/ws/messageHandler.ts` and add handling logic:

<!-- doc-block: none -- a handler branch for the invented message type -->
```typescript
if (message.type === 'stop_generation') {
  handleStopGeneration(ws, session);
}
```

### 4. Send it from the client

Add a helper on the client side that creates and sends the message:

<!-- doc-block: none -- a client helper for the invented message type -->
```typescript
function createStopMessage(): {type: 'stop_generation'} {
  return {type: 'stop_generation'};
}
```

---

## Adding a New Entry Type

If your feature introduces a new kind of conversation entry (a new `role`), you need to touch the session types and the rendering layer too.

### 1. Add to session types

Open `src/types/session.ts`:

<!-- doc-block: none -- a SystemNoticeEntry this document invents to demonstrate the steps -->
```typescript
export interface SystemNoticeEntry {
  role: 'system_notice';
  content: string;
  timestamp: string;
}

export type SessionEntry = UserEntry | AssistantEntry | ThinkingEntry | ToolEntry | SystemNoticeEntry;
```

### 2. Add an entry factory on the backend

Open `src/orchestration/entryFactories.ts`:

<!-- doc-block: none -- a factory for the invented entry type -->
```typescript
export function createSystemNoticeEntry(content: string): SessionEntry {
  return {role: 'system_notice', content, timestamp: new Date().toISOString()};
}
```

### 3. Handle on the client

On the client side, add rendering logic for the new entry type based on its `role` discriminant. If the new entry type supports streaming, handle it in your delta/commit logic. If it is a one-shot entry (like `tool`), `applyUpsert` handles it already.

## File reference

| File | Role |
|------|------|
| `src/types/messages.ts` | Backend message type definitions |
| `src/transport/ws/validation.ts` | Incoming message validation |
| `src/transport/ws/messageHandler.ts` | Message routing and handling |
| `src/transport/ws/sender.ts` | Outgoing message helpers |
| `src/orchestration/entryFactories.ts` | SessionEntry constructors |
| `src/types/session.ts` | Shared SessionEntry types |
