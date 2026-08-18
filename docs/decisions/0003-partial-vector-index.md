# 0003, A partial vector index over the facts in force

**Status:** accepted

## Context

Decision 0002 put embeddings on the fact rows. The index over them was created the obvious
way:

```sql
CREATE VECTOR INDEX facts_embedding_idx ON facts (embedding);
```

Every semantic query was a full table scan, and nothing said so. The index existed,
`SHOW INDEXES` listed it, `SHOW CREATE TABLE` rendered it. Two separate causes, both silent:

1. **The operator class defaults to `vector_l2_ops`**, which serves `<->` only. Ranking by
   cosine `<=>` against it is not an error, the planner simply never picks the index.
2. **A full index is not applicable under the `valid_to IS NULL` predicate** every live
   recall carries. Correcting the operator class was not enough; the filter alone sent the
   planner back to a scan.

Found by reading `EXPLAIN`, which nothing prompts a developer to do when the results are
correct and only the cost is wrong.

## Decision

```sql
CREATE VECTOR INDEX facts_live_embedding_idx
  ON facts (embedding vector_cosine_ops)
  WHERE valid_to IS NULL;
```

And `npm run verify` asserts the query plan, not just the results.

## Consequences

The restriction turns out to be the right shape rather than a workaround. Only facts in
force are ever semantically recalled, so **the index tracks the size of the present, not the
size of the history**. Retaining every superseded interval, decision 0001, costs storage
and costs the search nothing.

Measured at ten thousand facts, network baseline subtracted: 476 ms scanning against 177 ms
indexed, with the gap widening as the corpus grows.

Historical recall carries a different predicate and still scans. That path is analytical and
rare; the live path is the hot one and it is indexed. Fixing it properly needs an index per
time window, which is not worth its write cost here.

The index pre-split `facts` from one range into roughly 3,700. Worth knowing operationally,
and reported in the benchmark's `ranges` column rather than discovered later.

## Revisit if

CockroachDB makes a full vector index applicable under a filter, at which point the
partiality is no longer load-bearing, though it would still be the better shape for this
workload.
