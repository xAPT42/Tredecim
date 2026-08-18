# 0004, No language model in the decision loop

**Status:** accepted

## Context

This is an agent, and the obvious implementation routes the decision through a model: give
it the recalled facts, let it decide whether to refund.

## Decision

The policy is rule-based. Bedrock supplies embeddings and nothing else. No model sits
between a recalled fact and a payout.

## Consequences

The claim under test is that the memory layer keeps the agent correct. Routing money
through a sampled token stream would add a second variable to every result, and a failure
would be ambiguous between the two, a wrong payout could be bad memory or bad sampling, and
the test could not tell you which.

It also makes the demonstration reproducible. "Eight agents race one refund and exactly one
gets through" is a property of the database. Had the decision been sampled, it would have
been a property of the database *and* eight independent generations, and the result would
vary between runs.

The cost is honesty about what this is: an agent in the sense of durable, autonomous,
event-driven execution over persistent memory, not in the sense of a model reasoning in a
loop. The README says so rather than letting a reader assume otherwise.

## Revisit if

The interesting question becomes what an agent *decides* rather than what it *remembers*.
The seam is already there, `decide()` returns a proposal, and `act()` re-validates it
against live memory before anything moves, so a model could replace the rules without
touching the guarantees.
