# Definition of Done

> `ToolRegistry.execute` looks a tool up, logs the input's key names, and calls the executor without ever checking the declared `inputSchema`. Every tool declares a JSON Schema that is handed verbatim to both providers, but nothing validates what comes back from the model.

**Strategy: `direct`** — `ToolRegistry.execute` is already a public method with a defined signature; tests call it directly on a real `ToolRegistry` instance and observe whether validation happens before the executor runs. `ajv` is not yet in dependencies, so every validation test fails because the check is absent, not because the import is broken.

## Done when these pass

- [x] **returns a ToolResponse naming the missing required field and does not invoke the executor** — validates that a missing required field produces a rejection ToolResponse and the executor call count is 0
      `src/orchestration/tools/registry.test.ts`

- [x] **rejects a call whose field type is wrong, naming the field path and expected type but not the value** — validates type-mismatch rejection including PII redaction of the offending value
      `src/orchestration/tools/registry.test.ts`

- [x] **throws at register time when the inputSchema is uncompilable and the message names the tool** — validates compile-at-register behaviour
      `src/orchestration/tools/registry.test.ts`

- [x] **validates each call against the schema the definition function returns at that call** — validates that function-valued sources are resolved per call, not cached from register
      `src/orchestration/tools/registry.test.ts`

- [x] **does not include the rejected field value in the returned text or any log line** — validates PII redaction in both the returned text and captured log lines
      `src/orchestration/tools/registry.test.ts`

- [x] **resolves processMessage and makes the validation-rejection text visible to the provider on the next round** — validates the orchestrator delivers rejection as a tool result rather than throwing
      `src/orchestration/chatOrchestrator.test.ts`

- [x] **passes valid input with an extra property through to the executor unchanged** — passes today; guards against future over-validation stripping extra properties
      `src/orchestration/tools/registry.test.ts`

- [x] **throws for an unregistered tool name** — passes today; pins existing behaviour that must not change
      `src/orchestration/tools/registry.test.ts`

## Facets

- [x] Add `ajv` to `dependencies` in `package.json`
- [x] Compile static schemas at `register` time; throw naming the tool on failure
- [x] In `execute`, resolve the definition source and validate input against its schema; on failure return a `ToolResponse` with a message naming the failing path and constraint (no values)
- [x] Cache compiled validators for function-valued sources by resolved schema object identity (not by registration)
- [x] Add one-line doc comment to `execute` pointing at this spec
- [x] Update `docs/adding-a-tool.md`, `README.md`, `.specify/spec.md`
- [x] Add CHANGELOG entry
- [x] Run `node scripts/repoint-spec-anchors.mjs` after any edits that shift line numbers in cited files (script not present in repo; no line-number shifts in the spec — statement text was changed, not inserted/deleted)

## Out of scope

- `Unknown tool: <name>` throw becoming a tool result (tracked separately)
- Validating tool output
- Per-tool authorisation, retry, rate limiting
- Static "compile once" test (observable behaviour is covered by the repeated-call tests; the implementation detail is an optimisation, not a contract)
