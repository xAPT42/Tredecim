# Applying the CockroachDB Agent Skills to this cluster

The [Agent Skills repository](https://github.com/cockroachlabs/cockroachdb-skills) carries
34 machine-executable skills across ten domains. This is what applying the relevant ones to
a live Basic cluster running this workload actually turned up.

Installed with:

```bash
npx skills add cockroachlabs/cockroachdb-skills
```

## The finding worth acting on

**`hardening-user-privileges` caught the application user holding admin.**

```
SELECT current_user(),
       (SELECT count(*) FROM [SHOW GRANTS ON ROLE admin] WHERE member = current_user());

  tredecim_app | 1
```

The user in `DATABASE_URL`, the credential compiled into a public-facing web application 
could drop every table in the cluster. It got there the ordinary way: it is the user the
provisioning flow creates, it was convenient for migrations, and nothing ever prompted a
second look.

Fixed by splitting the roles the workload actually has:

| Role | Holds | Used by |
|---|---|---|
| `tredecim_app` | admin | migrations, run by a maintainer |
| `tredecim_runtime` | `SELECT, INSERT, UPDATE, DELETE` on six tables, `CONNECT`, `USAGE` | the deployed console |

Verified against the runtime user afterwards:

```
ok      read facts
ok      write tx_journal
REFUSE  CREATE TABLE     user tredecim_runtime does not have CREATE privilege on schema
REFUSE  DROP TABLE facts user tredecim_runtime does not have DROP privilege on relation
REFUSE  ALTER TABLE      must be owner of table facts or have CREATE privilege
```

One subtlety the skill is right to flag and which is easy to miss: **granting `USAGE` on
`public` is not enough**. CockroachDB grants `CREATE` on the public schema to the `public`
role by default, so the runtime user could still create tables until that was revoked
explicitly. `AS OF SYSTEM TIME` still works for it, so historical reads survive the
restriction.

## What the other skills reported

**`auditing-table-statistics`.** The planner's decisions are only as good as its statistics,
which matters here because the two hardest bugs in this project were the planner declining
an index. Automatic partial statistics on `facts` are being collected and are minutes old,
so the plan assertions in `verify` and `schema-check` are reading a planner with current
information rather than a stale one. No action.

**`cockroachdb-sql` anti-patterns.** Checked for the ones it names. No table is without an
explicit primary key. `facts` is keyed on `(entity_id, key, version)`, a natural composite
rather than a sequence, so there is no monotonic insert hotspot. `UUID` for entity
identifiers rather than `SERIAL`, for the same reason.

**`analyzing-range-distribution`.** Worth knowing operationally: creating the vector index
pre-split `facts` from a single range into roughly 3,700. That is the index doing its job on
a table whose row count does not remotely justify that many ranges on its own, and it is
reported in the benchmark's `ranges` column so the cost is visible rather than surprising.

**`designing-application-transactions`.** Its guidance matches what is already here 
retry on `40001` with exponential backoff and jitter, keep transactions short, take row
locks in a consistent order. One place this project deliberately diverges: the pool is sized
small for serverless, and a writer holds its connection while waiting on `FOR UPDATE`, so N
concurrent revisions of one row need N connections. Batch scripts raise the pool rather than
the application lowering its contention, because the contention is the point of the demo.

## Not applicable

`molt-fetch`, `molt-replicator` and `molt-verify` are migration tooling, and there is
nothing to migrate from. `designing-multi-region-applications`, `enabling-cmek-encryption`,
`configuring-private-connectivity`, `configuring-sso-and-scim` and `upgrading-cluster-version`
all address Advanced-tier or organisational concerns beyond a Basic cluster. Listed rather
than quietly skipped, so the coverage claim above is checkable.
