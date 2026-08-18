# 0001 — Two temporal axes rather than a version history

**Status:** accepted

## Context

An agent needs to know which version of a fact is current. The obvious answer is a version
history: keep every row, add a `version` column, read the highest.

That answers *what is current* and *what came before*. It cannot answer *what did the agent
believe when it acted*, because a version number does not say when the system learned
anything — only the order in which it wrote.

The distinction is not academic. Every question asked after an incident is of the second
kind. "The payment went to the wrong account" is followed by "what did the system know at
the time", not "what was the row's version number".

## Decision

Store two independent axes.

- **Valid time** — `valid_from` / `valid_to`, when a fact is true in the world.
- **Transaction time** — `recorded_at`, when the system learned it, plus the engine's own
  MVCC history through `AS OF SYSTEM TIME`.

Revising a fact closes the open interval and opens the next in one transaction. Nothing is
deleted, so the past stays queryable rather than reconstructible.

## Consequences

Facts accumulate forever, and every read carries a validity predicate. Both are paid for:
the partial vector index means history costs storage rather than query time, and the
predicate is what makes semantic recall unable to return a superseded fact.

Backdating becomes possible, which is the point — a fact can be true before anyone records
it — and also a hazard, which is why a CHECK constraint rejects an interval that ends
before it starts.

Two timestamps for transaction time is deliberate redundancy. `AS OF SYSTEM TIME` reads the
cluster as it physically was with no schema work, and is bounded by the garbage-collection
window. `recorded_at` survives indefinitely. Audit needs the second; a live demonstration
is better served by the first.

## Revisit if

Storage growth becomes the binding constraint before query latency does, or a deployment
acquires a legal obligation to forget. The mechanism for that already exists — row-level
TTL, applied to the journal today — and applying it to closed facts is a policy decision
belonging to whoever owns the data.
