# 0005, Record a hostile fact, refuse to act on it

**Status:** accepted

## Context

Memory poisoning is an active research thread, and its characteristic property is that it is
temporally decoupled. Someone asserts a new destination account, in the same words a real
customer would use, and it sits in memory looking like every other fact until an ordinary
refund request days later spends it. There is no malicious prompt to filter and no anomalous
request to catch.

The instinctive defence is to refuse the write.

## Decision

Accept the write. Gate the act.

`assertFact` records the revision whatever its provenance. The payout path reads `source`
and `confidence` under `FOR UPDATE`, inside the transaction that writes the ledger row, and
refuses if the destination is not `tool_verified` above the confidence floor.

## Consequences

A memory that declines to record what it was told has quietly decided what is true, and has
destroyed the evidence of the attempt. Recording and acting are different questions and only
the second is expensive to get wrong. After a refusal the history answers *when did this
enter*, *what did it replace*, and *what would have been paid an hour earlier*, from rows
nothing overwrote.

The check sits in `act`, not `decide`. An episode parked between deciding and acting can be
overtaken by an untrusted revision, so a check at decision time passes that case and pays
the attacker.

The refusal is terminal rather than retried. A stale decision is repaired by deciding again;
an untrusted destination is not, because the second decision reads the same fact. Retrying
would be a loop, not a recovery.

Trust is required to *move* money, not to withhold it: an unverified freeze still blocks a
payout. Asymmetry is deliberate, the safe direction should not need credentials.

## Revisit if

The floor needs to differ per key. One constant covers the payout path today, which is where
being wrong is priced; a larger system would declare it per fact type.
