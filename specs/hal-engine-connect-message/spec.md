# The Connect Message

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#67 |
| Status | Implemented          |

The text of the `connected` frame is the deployer's to set, so a client that opens the WebSocket directly can be told, in its first frame, that it is talking to an AI.

## Background

The `connected` frame is the first thing every socket receives, before any entry exists, and its `message` was a hardcoded English string about a product named HAL. A client that opens the WebSocket directly, as a third-party or customer-operated surface does, saw that string and nothing else. EU AI Act Article 50(1) requires that a person be told they are interacting with an AI system, at the latest at the first interaction, and for such a client the connect frame is the first interaction.

## The contract

- `transport.connectMessage` on `HalEngineConfig` sets the `connected` frame's `message`; unset, the frame is byte for byte what it was before the field existed, carrying `DEFAULT_CONNECT_MESSAGE` ([validated by: sends DEFAULT_CONNECT_MESSAGE in a frame byte-identical to the release before when no connectMessage is set](../../src/transport/ws/connectionHandler.test.ts#L54)).
- A set value is sent character for character, diacritics included, in the first frame on the socket, with `type`, `sessionId` and `examplePrompts` as they were ([validated by: sends a set connectMessage character for character, diacritics included, as the first frame with type and examplePrompts unchanged](../../src/transport/ws/connectionHandler.test.ts#L68)).
- The value travels from `createHalEngine` through `createServer` to the frame a real client receives ([validated by: carries transport.connectMessage to the first frame a real client receives](../../src/config.test.ts#L493)).
- A value present but blank or whitespace fails construction with an error naming `transport.connectMessage`, since a blank string set on purpose is indistinguishable from the default having been dropped; unset, or set to `undefined`, constructs normally ([validated by: throws at construction, naming transport.connectMessage, for a blank one; unset or absent constructs normally](../../src/config.test.ts#L458)).

## Rationale

It is the existing `message` field, made configurable: no wire type changes, so every client that parses the frame keeps working.

It is a static string, not a per-session resolver: nothing needs a per-user language today, and a resolver that threw would fail the connection before its first frame. It has no length cap, since it is server-side configuration, not untrusted input.

**EU AI Act.** A deployer serving EU users may carry the Article 50(1) disclosure in this field. The engine only sends the string and asserts nothing about a client rendering it, and a front end the deployer builds carries its own disclosure independently, so setting the field alone does not make a deployment compliant.
