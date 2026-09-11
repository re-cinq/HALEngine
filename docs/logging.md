# Logging

HAL Engine writes one JSON object per line to the process streams. Nothing in the package reads those lines back, so the format exists entirely for whatever collects them -- a log shipper, a container runtime, or a person running `jq`.

The logger is public surface: `src/index.ts` exports both the `log` object and the `Logger` type, and a consumer can pass their own implementation as `logger` in `HalEngineConfig`. This document describes the built-in one.

## The line

```json
{"severity":"INFO","message":"connected","timestamp":"2026-09-11T09:41:02.517Z","category":"ws","data":{"sessionId":"c1f...","userId":42}}
```

| Key | Always present | Meaning |
|---|---|---|
| `severity` | yes | The uppercase level name: `DEBUG`, `INFO`, `WARN` or `ERROR` |
| `message` | yes | The short, fixed string passed at the call site. Not interpolated -- values go in `data` |
| `timestamp` | yes | ISO-8601, UTC, millisecond precision, from `Date.prototype.toISOString` |
| `category` | yes | Which part of the engine emitted the line. One of `bedrock`, `message`, `orchestrator`, `server`, `stream`, `tool`, `vertex`, `ws` |
| `data` | no | The call site's fields, verbatim. Absent when the call passed none -- never `{}` |

Caller fields are nested under `data` rather than spread across the top level. That is deliberate: a field named `severity` or `timestamp` cannot overwrite the line's own, so the five keys above mean the same thing on every line regardless of what a call site passes.

## Levels

`LOG_LEVEL` selects the threshold, read once at module load and compared numerically: `debug` (0), `info` (1), `warn` (2), `error` (3). Anything below the threshold is dropped before the line is built. An unrecognised value falls back to `info`, and so does an unset one.

| `LOG_LEVEL` | Emits |
|---|---|
| `debug` | everything |
| `info` (default) | `INFO`, `WARN`, `ERROR` |
| `warn` | `WARN`, `ERROR` |
| `error` | `ERROR` only |

Because the threshold is resolved at import time, changing `process.env.LOG_LEVEL` after the module loads has no effect.

## Streams

`ERROR` goes to `console.error` (stderr). `DEBUG`, `INFO` and `WARN` go to `console.log` (stdout).

The split matters where the collector has no JSON parser in front of it: a container runtime that separates stdout from stderr can route or alert on failures without reading the payload at all. Where a parser is present, filtering on `severity` gives the same answer.

## Fields that can identify a person

Log lines are not scrubbed. These are the fields the engine itself emits that bear on a person, and a deployment's retention and access rules should account for them.

| Field | Category | What it is |
|---|---|---|
| `userId` | `ws` | The id your `WsAuthenticator` returned. Whatever identifier your system uses for a person -- often directly identifying |
| `sessionId` | `ws`, `message` | A per-connection UUID. Not identifying on its own, but it links every line of one conversation together, and pairs with `userId` on the connection line |
| `contentLength` | `message` | The character count of a user message. Metadata about what somebody typed, not the text |
| `inputKeys` | `tool` | The property names of a tool's input, not its values. Names can still disclose what was asked for |
| `error` | several | An error's `message`, which carries whatever the thrower put in it -- including, from a provider SDK, fragments of a request |

Message content, tool results and model output are never logged. If you supply your own `logger`, none of the above is enforced for you.
