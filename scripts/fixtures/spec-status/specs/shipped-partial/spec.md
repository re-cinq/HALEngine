# fixture lantern ferry

| Field  | Value                |
| ------ | -------------------- |
| Issue  | example/repo#17 |
| Status | Shipped              |

The lantern ferry crosses the estuary on the hour and carries a spare lamp for the return
leg after dusk.

## The rule

- The ferry leaves on the hour whatever the tide
  ([validated by](../../../../../src/orchestration/chatOrchestrator.test.ts#L14)).
- The spare lamp is lit before the return leg and never during the crossing.
