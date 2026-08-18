# HTTP API

Two routes. The console is the only client, and both are deliberately small.

## `GET /api/state`

Everything the console draws, in one round trip.

```jsonc
{
  "now": "2026-08-18T12:00:00.000Z",
  "provider": "bedrock",              // or "local"
  "facts": [ /* every interval for the demo account, closed and open */ ],
  "events": [ /* the twelve most recent */ ],
  "journal": [ /* fourteen most recent attempts, runs collapsed with a count */ ],
  "account": { "balanceCents": 100000, "movedCents": 0, "payouts": 0 },
  "metrics": {
    "closedFacts": 0,
    "openFacts": 3,
    "refusedWrites": 0,
    "p50CommitMs": 21          // null when nothing has been measured
  }
}
```

`p50CommitMs` is scoped to this account and measured over the most recent commits rather
than a wall-clock window. Both matter: a fixed window reports a confident 0 ms whenever the
demo has been idle, and an unscoped one mixes in writes from a developer's laptop, whose
round trip swamps the figure the console claims to be showing.

Returns **503** with a redacted driver message when the memory layer is unreachable. A
console that shows zeros when it cannot reach the database is worse than one that says so.

## `POST /api/act`

One write endpoint, four actions.

| `action` | Does |
|---|---|
| `event` | Ingest an event and drive its episode to completion. Takes `kind` and `payload` |
| `scenario` | Run one of the seven demonstrations. Takes `scenario` |
| `rewind` | Ask the memory what was true at an instant, what was known at it, and what is in force now. Takes `at` |
| `reset` | Clear the demo account and rebuild its opening history |

Returns **409** on a constraint violation rather than 500, because that outcome is the
system working. The console renders those refusals rather than hiding them.

### Scenarios

| id | Demonstrates |
|---|---|
| `supersede` | An interval closes, the next opens, nothing is deleted |
| `race` | Eight agents, one refund, seven refused with `23505` |
| `crash` | A worker killed between deciding and acting, resumed, paid once |
| `late-discovery` | A fact true before it was recorded, so the two clocks disagree |
| `stale-vector` | A superseded fact matching the query text and still unreachable |
| `poison` | An untrusted source asserts a destination; recorded, refused at payout |
| `async-window` | The same refund run with deferred extraction and with one transaction |
