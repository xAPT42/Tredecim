# 0002 — Embeddings on the fact rows rather than a vector store

**Status:** accepted

## Context

The conventional shape is a vector store beside the database: facts in Postgres, embeddings
in Pinecone or S3 Vectors, an identifier joining them.

It works until a fact changes. The vector store ranks by similarity and has nowhere to put
"and this one is no longer true". The superseded fact still matches the query text — often
better than its replacement, having had longer to accumulate context — and nothing marks
it dead. Keeping the two stores agreeing becomes an application concern, which means it is
a concern that fails silently.

## Decision

`embedding VECTOR(1024)` is a column on `facts`. Semantic recall is one query:

```sql
SELECT statement, embedding <=> $1 AS distance
  FROM facts
 WHERE entity_id = $2 AND valid_to IS NULL
 ORDER BY distance LIMIT 5;
```

Similarity ranking and validity are evaluated together, by one engine, in one transaction.
Moving the predicate to a validity window runs the same search against an earlier instant.

## Consequences

Semantic recall *cannot* return a closed fact. Not by convention, by construction — there
is no code path that reads a vector without also reading its interval.

Writes carry the embedding, so a revision costs an embedding call before it can commit. In
exchange there is no synchronisation to get wrong, no window where the two stores disagree,
and no reconciliation job.

Embeddings are keyed by provider in the cache, because a fallback vector cached under the
bare text would be compared against a different vector space long after the outage that
produced it ended. That is the failure mode this decision is meant to prevent, reappearing
one level down.

## Revisit if

Embedding dimensionality or corpus size grows past what a transactional store handles well,
or write latency on the memory path becomes the bottleneck. Neither is close: the partial
index serves ten thousand facts in 177 ms of server time.
