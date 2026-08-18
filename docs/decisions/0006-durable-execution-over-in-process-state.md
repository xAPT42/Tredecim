# 0006 — Durable execution rather than in-process agent state

**Status:** accepted

## Context

An agent loop naturally holds its working state in the process: recalled facts in a
variable, the decision in another, the whole run in one function.

AWS states the failure plainly in its own documentation of in-memory agent state: "it is
ephemeral and local. When the process stops, the data is lost. If you run multiple workers,
each instance keeps its own memory. You cannot resume a session that started elsewhere, and
you cannot recover if a workflow crashes halfway."

## Decision

The agent holds nothing between steps. Every transition — `recall`, `decide`, `act` — is
written to `episodes` before the next begins. A recovery sweep re-runs anything still marked
running.

## Consequences

A worker killed at any instruction boundary is resumed by another from where it stopped.
Replay is safe because side effects are idempotent or transactional.

The cost is the interesting part. Making execution durable **creates** an unbounded gap
between deciding and acting, which does not exist when both happen in one function call. A
customer can change their bank details while an episode is parked.

So a decision is a proposal rather than an authorisation, and `act` re-reads the facts it
depends on under `FOR UPDATE` before money moves. That re-validation is not an extra safety
measure bolted on; it is the direct consequence of this decision, and without it durability
would have made the system less correct rather than more.

Checkpointing costs a write per step. At the demonstrated scale that is invisible next to
the round trip.

## Revisit if

Step granularity becomes too coarse to resume usefully, or too fine to afford. Three steps
is right for this workload; a longer agent would want its own boundaries rather than these.
