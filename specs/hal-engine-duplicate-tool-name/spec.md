# A Duplicate Tool Name

| Field  | Value                |
| ------ | -------------------- |
| Issue  | re-cinq/HALEngine#55 |
| Status | Implemented          |

`ToolRegistry.register` stored each tool under its name with a plain `Map.set`, so a second tool registered under a name already taken silently replaced the first. The first tool became unreachable through `execute` and vanished from `getDefinitions()` and the system prompt, and nothing logged the collision. A copy-pasted `name` in boot code is exactly the mistake a compiler cannot catch, and the model then answers with the wrong tool's data or none.

## The contract

- `register` refuses a name already registered: the second call throws `Error('Duplicate tool name: <name>')`, and the registry keeps the first tool, its definition and its executor ([validated by: throws Duplicate tool name: get_weather on the second register and keeps the first tool and its executor](../../src/orchestration/tools/registry.test.ts#L320)).
- The name checked is the one the definition resolves to at registration, for a plain definition and a definition function alike ([validated by: throws for a definition function that resolves to get_weather once a plain definition holds that name](../../src/orchestration/tools/registry.test.ts#L341)).

## Rationale

Registration runs in a consumer's boot code, so a collision becomes a startup failure naming the tool, the cheapest place to learn of it, instead of a silent loss at runtime.

- **No last-wins mode, and no `unregister`.** Replacing a tool at runtime raises its own questions, such as calls already in flight and the tool list already sent to the model. Until an API answers them, a collision is always an error.
- **No deprecation window.** The removed behaviour was undocumented, silently lost a tool, and has no known user: every in-tree caller registers distinct names. It ships in a minor release, and the migration is to give the tools distinct names.
- **Out of scope.** A definition function that resolves to a different name after registration: the key is captured at `register`, and resolving tools per turn is a separate question.
