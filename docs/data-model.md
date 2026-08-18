# Data model

Six tables. The interesting one is `facts`; the rest exist to make its guarantees
demonstrable.

## `facts` — the memory

| Column | Why it exists |
|---|---|
| `entity_id`, `key`, `version` | Primary key. A natural composite rather than a sequence, so there is no monotonic insert hotspot |
| `value` JSONB | What the fact says |
| `statement` | The natural-language form, and what gets embedded |
| `valid_from`, `valid_to` | **Valid time.** `valid_to IS NULL` means in force. Half-open: `[valid_from, valid_to)` |
| `recorded_at` | **Transaction time**, durable past the MVCC garbage-collection horizon |
| `source`, `confidence` | Provenance. Read by the payout path, not decoration |
| `superseded_by` | Which version closed this one |
| `embedding` VECTOR(1024) | Titan Text Embeddings v2. On the row, not in a separate store |

### The invariant

```sql
CREATE UNIQUE INDEX facts_one_open
  ON facts (entity_id, key) WHERE valid_to IS NULL;
```

At most one open interval per (entity, key), enforced by the storage engine. It holds
against the application, a script, a migration, and anything else that reaches the cluster.

```sql
CONSTRAINT facts_interval_ordered CHECK (valid_to IS NULL OR valid_to > valid_from)
```

An interval that ends before it starts is not a fact, it is corruption. Backdating is a
legitimate use of `valid_from`, so the ordering is enforced rather than trusted.

### The indexes

| Index | Serves |
|---|---|
| `facts_one_open` | The invariant, and current-value lookups |
| `facts_valid_window` | Point-in-time reads — "what was true at T" |
| `facts_live_embedding_idx` | Semantic recall. Partial, cosine. See [decision 0003](decisions/0003-partial-vector-index.md) |

## `episodes` — agent state

One durable run. `step` moves `recall → decide → act → done`, checkpointed before each
transition, so a killed worker is resumed rather than restarted. `scratch` holds the working
state that would otherwise live in the process.

## `ledger` and `accounts` — where the money is

`ledger.idempotency_key` is unique, which is what makes eight agents racing one refund
produce exactly one payout. `accounts.balance_cents` is debited in the same transaction as
the memory of having debited it.

## `events` — what arrives

Inbound events the agent reacts to. `handled_at` marks completion.

## `tx_journal` — every attempt

Including the ones the database refused; the aborts are the interesting rows. Carries
`entity_id` directly rather than inferring attribution from timestamps, because an
episode-less write is otherwise indistinguishable from another account's traffic.

Row-level TTL expires it after seven days. It is the only table with one — see
[decision 0001](decisions/0001-bitemporal-not-versioned.md) for why `facts` has none.

## The revision, in full

```sql
BEGIN;
  UPDATE facts SET valid_to = $now, superseded_by = $next
   WHERE entity_id = $e AND key = $k AND valid_to IS NULL;

  INSERT INTO facts (entity_id, key, version, value, statement,
                     valid_from, valid_to, source, confidence, embedding)
  VALUES ($e, $k, $next, $v, $s, $now, NULL, $source, $confidence, $embedding);

  -- the business write rides along here
COMMIT;
```

Both, or neither.
