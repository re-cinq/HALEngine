# Definition of Done

> the engine accepts a value it uses as a database filter without ever checking its shape

**Strategy: `direct`** — Seams exist at `createUpgradeHandler` (where `wsAuth`'s return value first enters the engine) and at `InMemorySessionStore`/`MongoSessionStore` method boundaries. Both are directly callable with no scaffolding required.

## Done when these pass

- [ ] **non-scalar id refused at upgrade** — `createUpgradeHandler` answers `401` for every non-scalar id variant (`{$ne:null}`, `null`, `undefined`, `[]`, `NaN`, `Infinity`) and still accepts a string or finite-number id
  `src/transport/malformedUpgrade.test.ts`

- [ ] **refusal logged by type, not value** — after `wsAuth` returns a non-scalar id the upgrade handler emits an error log that records the id's type and no substring of its contents
  `src/transport/ws/connectionHandler.test.ts`

- [ ] **InMemorySessionStore refuses non-scalar userId** — `create` and `latestFor` throw when given a non-scalar userId
  `src/infrastructure/stores/inMemorySessionStore.test.ts`

- [ ] **MongoSessionStore refuses non-scalar userId without querying** — `create` and `latestFor` reject before touching the collection; zero queries issued
  `src/infrastructure/stores/mongo/mongoScalarId.test.ts`

## Facets

- [ ] Add a scalar-id guard (e.g. `assertScalarUserId`) exported from `src/infrastructure/stores/` so stores and the upgrade handler share one implementation
- [ ] Apply the guard in `createUpgradeHandler` after `wsAuth` resolves: log `{idType: typeof user.id}` at error level, then call `rejectSocket(socket, '401 Unauthorized')`
- [ ] Apply the guard in `InMemorySessionStore.create` and `InMemorySessionStore.latestFor`
- [ ] Apply the guard in `MongoSessionStore.create` and `MongoSessionStore.latestFor`
- [ ] Add spec statements to `specs/hal-engine-websocket-protocol/spec.md` § 12 (Security Considerations) and cite the tests with the established parenthetical form
- [ ] Update `docs/getting-started.md` § Authentication: what `id` must be (`string | finite number`) and what happens when it is not (401, logged as authenticator fault)
- [ ] Add `CHANGELOG.md` entry with MINOR version bump; PR body notes the breaking change for consumers whose authenticator returns a non-scalar id
- [ ] `npm run verify` passes

## Out of scope

- `listFor` — the ticket body references it alongside `latestFor`, but no such method exists on any store; the implementer should clarify whether this is a new method or a slip for `latestFor`
- `workspaceId` and any other consumer-supplied value reaching a store
- Tool input validation (#85)
- HTTP routes (demo-only)
- Rate limiting a repeatedly failing authenticator (#40)
