# Testing

Four suites, each answering a different question. None of them is a unit test, and that is
deliberate: nothing interesting in this project is true in isolation. The claims are about
how a database behaves under concurrency, so they are asserted against a live cluster.

## `npm run verify` — 64 assertions, eleven sections

The gate. Runs against a real CockroachDB cluster and exits non-zero on any failure.

| Section | Asserts |
|---|---|
| 1 | At most one open interval per (entity, key), including against a raw `INSERT` that bypasses the API |
| 2 | Valid time and transaction time are independently queryable and disagree correctly |
| 3 | Semantic recall is constrained by validity, forwards and rewound |
| 4 | Eight concurrent agents cannot double-pay one request |
| 5 | An episode killed mid-flight resumes and pays exactly once |
| 6 | Event to memory, end to end, including a freeze blocking a later payout |
| 7 | A decision is re-validated against live memory before money moves |
| 8 | The planner uses the partial vector index, with the right operator class |
| 9 | Twelve rapid concurrent revisions all land, none degenerate |
| 10 | Provenance is enforced where money moves, not merely recorded |
| 11 | Money and the memory of it commit together, or not at all |

Section 8 reads `EXPLAIN`. It is there because the two most expensive bugs in this project
were an index the planner declined — a failure invisible to any test that only checks
results.

Section 11 runs the same refund two ways and reads the outcome back from the database
rather than trusting what either path reported.

## `npm run schema-check` — 26 checks

Drift detection. Compares three sources and fails when they disagree: what `lib/schema.sql`
declares, what the TypeScript depends on, and **what the cluster actually holds**.

An index built with the wrong operator class, or full where it needs to be partial, passes
every functional test and silently costs a scan per query. This is what catches that.

## `npm run e2e` — browser journey

Drives Chromium against the deployed console and walks a first-time visitor's whole path:
the page loads, the state endpoint answers, every scenario button runs and changes what the
console reports, the lifeline shows both sides of a revision, the temporal query answers on
both axes, nothing throws, no request 5xxs, and the layout holds at two viewport sizes.

It has caught things nothing else could: an overlay intercepting a scenario click, and a
label giving the page a horizontal scrollbar in the default view.

## `npm run bench` — measurement, not assertion

Write latency, point-in-time reads, semantic recall against a growing corpus, and
concurrent revisions of one key. Reports the **query plan** alongside every latency, so a
number that looks acceptable while silently scanning is legible as such. Subtracts the
measured network baseline, because every raw figure carries a round trip that has nothing to
do with the index.

Cleans up after itself under its own entity namespace and asserts at startup that its range
cannot overlap the demo account.

## `npm run reembed`

Not a test, but it belongs next to them. Rewrites every embedding with the currently
configured provider. Switching provider is not a matter of changing an env var: vectors
from different models occupy different spaces, and comparing across them yields a number
with no meaning.

## What none of these cover

- **Bedrock failure modes beyond the fallback.** The embedding provider falls back to a
  local implementation and the fallback is exercised, but throttling, partial responses and
  regional outages are not simulated.
- **Multi-region behaviour.** The cluster is single-region. Nothing here tests what
  happens when a region is lost.
- **Load beyond sixteen concurrent writers.** The contention section stops there.
- **The console's visual output.** `e2e` asserts that elements exist and state changes; it
  does not compare renderings.
