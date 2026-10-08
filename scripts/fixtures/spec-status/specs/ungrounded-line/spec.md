# fixture tide board

| Field  | Value           |
| ------ | --------------- |
| Issue  | example/repo#17 |
| Status | Shipped         |

The tide board at the harbour mouth is chalked twice a day from the almanac, so a skipper
reads the next two tides and never last week's.

## The rule

- A tide is chalked from the almanac and never from the previous day's board
  ([validated by](../../../../../src/orchestration/chatOrchestrator.test.ts#L1)).
- The board is wiped before the morning entry goes up.
