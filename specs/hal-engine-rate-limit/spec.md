# The Inbound Rate Limit

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#40 |
| Status | Implemented          |

`transport.rateLimit` bounds how often one authenticated user may send: 20 requests a minute sustained and 5 at once by default, one budget across the WebSocket and HTTP transports. A refused `user_message` is answered in turn with an `error` frame, code `TOO_MANY_REQUESTS` carrying `retryAfterMs`, then `stream_end`, and starts no model call; a refused HTTP request answers 429 with `Retry-After`. The limiter is in memory and per engine instance, and `false` turns it off.

## Background

Message size was capped (`validation.ts` refuses a `content` over 10,000 characters) but frequency was not: an authenticated user could open a socket and fire a message every millisecond, and each one started a full orchestrator run of up to `maxToolRounds + 1` provider calls, billed, and forwarding that user's data to the vendor. For a deployment serving end users this is the availability control: one misbehaving browser tab, or one loop in a third party's integration, could degrade the service for every other user and run up an unbudgeted bill. The engine's own configuration overview promised that an administrator sets rate limits, and nothing implemented it.

## The budget

- Five immediate calls pass at the defaults, `{limit: 20, windowMs: 60000, burst: 5}`; the sixth is refused with `retryAfterMs` equal to the refill interval, and one more passes once that interval has elapsed ([validated by: allows five immediate calls at {limit: 20, windowMs: 60000, burst: 5}, refuses the sixth with retryAfterMs 3000, and allows one more 3000 ms later](../../src/transport/rateLimit.test.ts#L24)).
- A key idle long enough to refill in full answers as a new one: it is dropped from memory, and a full bucket and a missing one answer alike ([validated by: answers a key idle for a whole window as a new one: five allowed again after 60000 ms of silence](../../src/transport/rateLimit.test.ts#L44)).
- A key is kept while it is still refilling, so a burst above the limit is not handed back early ([validated by: keeps a key through a whole idle window when burst exceeds limit: {limit: 2, windowMs: 60000, burst: 10} allows two, not ten, after 60000 ms](../../src/transport/rateLimit.test.ts#L52)).
- A limit, window or burst that is not a positive finite number, or a burst below 1, is refused at construction rather than read as "no limit" ([validated by: refuses a limit, window or burst that is not a positive finite number, and a burst below 1](../../src/transport/rateLimit.test.ts#L60)).
- Unset, `transport.rateLimit` means the defaults; `false` means no limiter at all ([validated by: builds the default limiter, five at once, when transport.rateLimit is unset, and none when it is false](../../src/transport/rateLimit.test.ts#L75)).
- A partial setting is merged with the defaults field by field ([validated by: merges a partial setting with the defaults: {burst: 2} refuses the third immediate call](../../src/transport/rateLimit.test.ts#L84)).

## Whose budget

- One user's exhaustion leaves another's bucket untouched ([validated by: keeps one key out of another: u2 is allowed right after u1 was refused](../../src/transport/rateLimit.test.ts#L37)).
- Two sessions of one user draw on one bucket, keyed `user:<id>` ([validated by: draws two sessions of user u1 on one bucket: three messages on s1 and two on s2 are allowed, s2's third is refused](../../src/transport/ws/rateLimitWs.test.ts#L83)).
- The HTTP middleware keys on `req.user.id` when a middleware before it set a usable one, else on the remote address; an empty or non-scalar id counts as none ([validated by: keys on req.user.id when a middleware before it set a usable one, and on the remote address when none did or the id is empty](../../src/transport/rateLimitHttp.test.ts#L105)).

## HTTP

- The sixth immediate request to a consumer's route answers 429 with `Retry-After` in whole seconds and a JSON body carrying `code: 'TOO_MANY_REQUESTS'` and `retryAfterMs` ([validated by: answers the sixth immediate request to an additional route 429 with Retry-After 3 and code TOO_MANY_REQUESTS, after five 200s](../../src/transport/rateLimitHttp.test.ts#L61)).
- The same budget covers a consumer's root routes ([validated by: covers a root route too: a caller refused on /hal/ping is refused on /](../../src/transport/rateLimitHttp.test.ts#L75)).
- The engine's chat routes authenticate first and limit second, so a REST chat request is keyed on its user ([validated by: keys the chat routes on the authenticated user: two users behind one address each get five POST /hal/chats before a 429](../../src/transport/rateLimitHttp.test.ts#L82)).
- `${basePath}/health` is never refused ([validated by: never refuses /hal/health, which answers liveness probes, however often it is called](../../src/transport/rateLimitHttp.test.ts#L91)).
- With no limiter, nothing is mounted and nothing is refused ([validated by: mounts none: thirty immediate requests to /hal/ping all answer 200](../../src/transport/rateLimitHttp.test.ts#L99)).

## WebSocket

- The sixth `user_message` in a row is refused with one `error` frame, code `TOO_MANY_REQUESTS` with `retryAfterMs`, then `stream_end`, and the orchestrator runs no sixth turn ([validated by: refuses the sixth user_message of user u1 in a row with one error TOO_MANY_REQUESTS carrying retryAfterMs 3000 and a stream_end, running no sixth turn](../../src/transport/ws/rateLimitWs.test.ts#L57)).
- A refusal queues behind the session's in-flight turn, so its frames follow that answer's `stream_end` ([validated by: queues a refusal behind the session's earlier turn, so its error and stream_end follow that answer's stream_end](../../src/transport/ws/rateLimitWs.test.ts#L107)).
- A `ping` is answered and never counted ([validated by: counts no ping: ten pings between a user_message and the next still leave that next one allowed at burst 11](../../src/transport/ws/rateLimitWs.test.ts#L69)).
- With no limiter, no `user_message` is refused ([validated by: refuses nothing without a limiter: thirty user_messages in a row all run](../../src/transport/ws/rateLimitWs.test.ts#L96)).

## Privacy

- The limiter holds user identifiers in memory with a token count and a timestamp, persists nothing, and drops a key once it has refilled in full ([validated by: answers a key idle for a whole window as a new one: five allowed again after 60000 ms of silence](../../src/transport/rateLimit.test.ts#L44)).
- A refusal's log line carries `sessionId` and `retryAfterMs` and nothing of the message or of `session.authHeaders` ([validated by: logs a refusal with sessionId and retryAfterMs alone: neither the message content nor the authorization header reaches any log line](../../src/transport/ws/rateLimitWs.test.ts#L124)).

## Rationale

A token bucket per key: `burst` tokens to start, refilled at `limit` per `windowMs`, one token per request. The defaults allow one message every three seconds sustained and five at once, above a human typing and below a loop; they rest on no production evidence yet, and a deployment that learns better numbers sets its own. `false` installs no limiter, for a deployment whose gateway already limits, since a library that cannot be told to stand aside breaks exactly that consumer.

The key is the user on both transports, so a user's HTTP requests and WebSocket messages draw on one budget, and so do two sessions or two sockets of the same user. The remote address keys only an HTTP request that reaches the limiter with no user set, because a whole office can sit behind one address and must not share one bucket once its people are known.

On HTTP the engine's chat routes authenticate first and limit second, so they key on the user; every other route, anything a consumer mounts through `additionalRoutes` or `rootRoutes` included, is limited before it runs. `${basePath}/health` comes before the limiter on purpose: a liveness probe answered 429 would restart a healthy pod.

On the WebSocket the token is consumed when a `user_message` frame arrives, so the sending rate is what is limited, and the refusal is answered on the session's per-session lock like any turn, so it never ends an earlier answer early. A refused turn keeps a turn's shape under the single-terminal-frame contract. Only `user_message` frames count: a `ping` answers the heartbeat and a `list_conversations` is a bounded read, and counting either would disconnect the healthiest clients first. A refusal's log line is a session id and a wait, since a user id plus a count is the whole record.

## Limitations

The limit is per engine instance and in process: N instances behind a load balancer permit N times the limit. The engine ships no shared store and this feature adds none; a deployment that needs a true global limit puts it at the gateway, where `rateLimit: false` keeps the engine out of its way.

A route a consumer mounts through `additionalRoutes` or `rootRoutes` is keyed on the remote address unless the consumer runs an authenticating middleware in front of the app, since the engine cannot know that route's user; the engine's own chat routes and every WebSocket frame key on the user.

## Out of scope

Retrying or timing out the outbound provider call, which bounds what the engine sends a vendor rather than what a caller sends the engine; serializing concurrent messages within one session, which the per-session lock already does; message size limits (`validation.ts`); a shared or persistent limiter store; per-tool or per-token budgets (`maxToolRounds` bounds tool calls per message); and rate limiting the REST chat routes on their own, which the app-wide mount covers anyway.
