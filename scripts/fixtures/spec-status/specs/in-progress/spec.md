# fixture kite stall

| Field  | Value                |
| ------ | -------------------- |
| Issue  | example/repo#17 |
| Status | In Progress          |

The kite stall on the north pier keeps two colours of twine behind the counter and restocks
whichever spool runs low first.

## The rule

- Twine is sold by the metre and never by the spool
  ([validated by](../../../../../src/orchestration/chatOrchestrator.test.ts#L14)).
- A kite is sold whole, so a broken spar is replaced rather than sold on its own.
