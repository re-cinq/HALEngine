# Definition of Done

> the engine accepts a value it uses as a database filter without ever checking its shape

**Strategy: `direct`** — The `listFor` method boundaries in both `InMemorySessionStore` and `MongoSessionStore` are directly callable.
The red bar is CI's to show; the CI job that runs the tests is "Test (with coverage floor)".

## Done when these pass

- [ ] **listFor scalar id guard** — `InMemorySessionStore` throws, and `MongoSessionStore` rejects without querying, when `listFor` is called with a non-scalar userId
      src/infrastructure/stores/listForScalarId.acceptance.test.ts

## Facets

- [x] Apply `assertScalarUserId` in `InMemorySessionStore.listFor`
- [x] Apply `assertScalarUserId` in `MongoSessionStore.listFor`

## Out of scope

- `workspaceId` and any other consumer-supplied value reaching a store
