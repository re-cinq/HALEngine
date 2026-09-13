# Logging

HAL Engine writes one JSON object per line to the process streams. Nothing in the package reads those lines back, so the format exists entirely for whatever collects them -- a log shipper, a container runtime, or a person running `jq`.

The logger is public surface: `src/index.ts` exports the `log` object, the `setLogger` function and the `Logger` type, and a consumer can pass their own implementation as `logger` in `HalEngineConfig`. This document describes the built-in one.

## The line

```json
{"severity":"INFO","message":"connected","timestamp":"2026-09-11T09:41:02.517Z","category":"ws","data":{"sessionId":"c1f...","userId":42}}
```

| Key | Always present | Meaning |
|---|---|---|
| `severity` | yes | The uppercase level name: `DEBUG`, `INFO`, `WARN` or `ERROR` |
| `message` | yes | The short, fixed string passed at the call site. Not interpolated -- values go in `data` |
| `timestamp` | yes | ISO-8601, UTC, millisecond precision, from `Date.prototype.toISOString` |
| `category` | yes | Which part of the engine emitted the line. One of `bedrock`, `http`, `message`, `orchestrator`, `server`, `stream`, `tool`, `vertex`, `ws` |
| `data` | no | The call site's fields, verbatim. Absent when the call passed none -- never `{}` |

Caller fields are nested under `data` rather than spread across the top level. That is deliberate: a field named `severity` or `timestamp` cannot overwrite the line's own, so the five keys above mean the same thing on every line regardless of what a call site passes.

If `data` cannot be serialised -- a circular reference, a `BigInt` -- the line is still written, with the other four keys intact and `data` replaced by a string naming the reason. The emitter never throws: a logger that can take down the call site it is observing is the wrong failure mode, and a collector still needs the severity and the message.

```json
{"severity":"INFO","message":"connected","timestamp":"2026-09-11T09:41:02.517Z","category":"ws","data":"[unserialisable]: Converting circular structure to JSON"}
```

Note the shape change: `data` is a string here rather than an object. A consumer indexing that field should expect either.

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

## Supplying your own

Pass `logger` in `HalEngineConfig` and every line above goes to your implementation instead of the console, called with the three arguments the `Logger` interface declares -- `category`, `message`, and the optional fields object. `setLogger` is exported too, for an engine you assemble by hand or to put the built-in logger back: calling it with no argument restores the console one.

`LOG_LEVEL` gates your logger exactly as it gates the built-in one. The threshold is tested once, before dispatch, so a level below it never reaches you at all.

If your logger throws -- a transport that is not ready, a full disk -- the throw does not propagate into the call site being logged, and the line is written to the console so that it is not lost. The same holds for a logger missing one of the four methods.

Note what that means for a logger that writes and *then* throws, which is the ordinary shape of a buffered transport failing to flush: the line is emitted twice, once by you and once to the console. The fallback guarantees a line is never lost, not that it appears exactly once. If double emission matters more to you than losing the line, catch inside your own implementation and return normally.

One caveat, and it is the reason this is documented rather than assumed. The swap is **process-wide, not per engine**, and it persists: `createHalEngine` sets your logger when the config names one and otherwise leaves whatever was last set in place, so a second engine that names none keeps using the first one's logger until `setLogger()` puts the console back. Every module that logs imports the `log` object at module scope, so there is one logger per process; two engines in the same process share whichever was constructed last. If you run more than one engine in a process and need their lines apart, put the distinguishing field in your own implementation rather than expecting the package to carry it.

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
