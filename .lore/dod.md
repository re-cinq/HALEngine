# Definition of Done

> but `createHalEngine` never passes them through, and no route lets a consumer serve anything from `/` because every forwarded route lands under `basePath`.

**Strategy: `direct`** — `createApp` and `createHalEngine` are both callable today and produce the wrong observable behavior: `rootRoutes` is absent from `HalAppOptions` so any handler registered via that option is silently ignored, and `createHalEngine` ignores `transport.additionalRoutes` because it never passes it to `createApp`.

## Done when these pass

- [x] **mounts a rootRoutes handler at / before the catch-all 404** — `createApp({ rootRoutes: r => r.get('/', ...) })` makes `GET /` return 200 while `GET /hal/health` still returns 200. Fails today: `rootRoutes` is not in `HalAppOptions`; the callback is never called; `GET /` returns 404.
      `src/transport/createApp.test.ts`

- [x] **lets rootRoutes at /health and the basePath health answer independently** — same app with `rootRoutes` serving `GET /health`; the root handler answers and `GET /hal/health` still answers separately. Fails today: same absent `rootRoutes`.
      `src/transport/createApp.test.ts`

- [x] **forwards transport.additionalRoutes to createApp so the route mounts under basePath** — `createHalEngine` with `transport.additionalRoutes` registering `GET /ping`; `GET /hal/ping` returns 200. Fails today: `createHalEngine` does not forward the option to `createApp`.
      `src/config.test.ts`

## Facets

- [x] Add `rootRoutes?: (router: Router) => void` to `HalAppOptions` in `src/transport/createApp.ts`, mounted after the `basePath` router and before the 404 catch-all.
- [x] Add `additionalRoutes`, `rootRoutes`, and `errorHandler` to `HalEngineConfig['transport']` in `src/config.ts`.
- [x] Forward all three from `createHalEngine` to `createApp`.
- [x] Remove the `as any` cast in `src/config.test.ts` once the type exists.
- [x] Add spec statements (Engine Lifecycle section) for the six config.test.ts tests that lacked spec links (CI repair: re-lint/require-spec-link).
- [ ] Update `docs/getting-started.md`, `README.md`, `example/full-config.ts` per ticket, regenerate doc blocks with `npm run docs:fix`.
- [ ] Add `CHANGELOG.md` entry.

## Out of scope

- A safe default JSON error handler inside the engine (separate ticket: "Answer unhandled HTTP errors with a safe JSON response").
- Per-route authentication in the engine.
- Deferring the 404 or any post-hoc extension of `engine.app` after `createHalEngine` returns.
- `createServer` / WebSocket upgrade handling.
