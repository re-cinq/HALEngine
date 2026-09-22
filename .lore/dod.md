# Definition of Done

> The `eu` multi-region is not a location string. It is a separate host,
> `aiplatform.eu.rep.googleapis.com`, and `@google-cloud/vertexai` builds its
> endpoint from `location` unless it is given one. So today a consumer cannot
> reach it through HAL Engine at all, no matter what they put in `location`.

**Strategy: `direct`** — the seam already exists. `vertexProvider.test.ts` mocks
`requireOptionalPeer`, so the SDK `VertexAI` constructor is reachable from the
test. The only change needed was to capture that constructor in a module-level
`jest.fn` (`mockVertexAI`) so a test can read back the init object it receives;
the real entry point `createVertexProvider` is driven unchanged.

## Done when these pass

- [x] **forwards apiEndpoint to the VertexAI constructor for the eu multi-region and omits it when unset** —
      drives `createVertexProvider({location: 'eu', apiEndpoint: 'aiplatform.eu.rep.googleapis.com', ...})`
      and asserts the init object reaching `new VertexAI(...)` carries
      `apiEndpoint` verbatim (no rewriting) alongside `location: 'eu'`; a second
      call with no `apiEndpoint` must reach the constructor with no endpoint
      override, so single-region deployments stay byte-for-byte unchanged.
      Split into two tests at `src/providers/vertex/vertexProvider.test.ts#L297` and `#L309`.

## Facets

- [x] Capture the `VertexAI` constructor mock at module scope so its call args are readable.
- [x] Red acceptance test: EU config passes `apiEndpoint` through; absent config passes no override.
- [x] Add `apiEndpoint?: string` to `VertexConfig` with a JSDoc line naming the EU multi-region host.
- [x] Pass `apiEndpoint` to `new VertexAI({...})` only when set (conditional spread keeps the default byte-for-byte).
- [x] `docs`/README/changelog + MINOR version bump (prose; not test-owed).

## Out of scope

- The docs/README example, changelog entry and version bump — prose, not
  observable behaviour, left to the implementer (the ticket names a
  `docs/providers.md` that does not exist in this repo; the Vertex example
  lives in `specs/hal-engine-providers/spec.md`).
- The "no hardcoded vendor hostname" and "endpoint never logged" criteria are
  already true on the branch base (construction logs nothing; `sendMessage`
  logs only `modelId`/`messageCount`/`hasTools`) — no red test exists for an
  already-satisfied invariant, so none is written.
- Choosing a model/region for any consumer, Otto's allowlist, the `global`
  endpoint, Bedrock multi-region, and any retry/failover/availability probing.
