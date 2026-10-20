# fixture chart table

| Field  | Value           |
| ------ | --------------- |
| Issue  | example/repo#17 |
| Status | Shipped         |

The chart table under the stern window holds one chart at a time, so a passage plotted on it
is rolled away before the next is laid out.

## The rule

- A chart is weighted at all four corners and never held by hand
  ([validated by](../../../../../src/orchestration/noSuchOrchestrator.test.ts#L14)).
- A plotted passage is initialled by the mate before the chart is rolled away.
