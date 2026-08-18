# Security

## Credential separation

The application user held admin. It got there the ordinary way — it is the user the
provisioning flow creates, it was convenient for migrations, and nothing prompted a second
look until a skill from the CockroachDB Agent Skills repository asked the question directly.

A credential compiled into a public-facing web application could drop every table in the
cluster.

| Role | Holds | Used by |
|---|---|---|
| `tredecim_app` | admin | migrations, run by a maintainer |
| `tredecim_runtime` | `SELECT, INSERT, UPDATE, DELETE` on six tables, `CONNECT`, `USAGE` | the deployed console |

Verified against the runtime user:

```
ok      read facts
ok      write tx_journal
ok      AS OF SYSTEM TIME
REFUSE  CREATE TABLE     does not have CREATE privilege on schema
REFUSE  DROP TABLE facts does not have DROP privilege on relation
REFUSE  ALTER TABLE      must be owner of table facts
```

One subtlety worth repeating: **granting `USAGE` on `public` is not enough**. CockroachDB
grants `CREATE` on the public schema to the `public` role by default, so the runtime user
could still create tables until that was revoked explicitly.

## Secrets

`.env*` is ignored, with `.env.example` exempted — it carries a template and no values.

The hosting platform exposes console-configured variables to the build container and not to
the SSR runtime, so runtime configuration is inlined into the compiled server output. That
is safe only while those values are referenced from server modules alone, which is an
assumption a single import could break.

So it is checked rather than trusted. `scripts/check-bundle.ts` scans browser-served output
for every configured secret after each build and exits non-zero on a match. Verified by
planting a value in `.next/static`: the build fails, and passes again once removed.

## Transport

`rejectUnauthorized` is pinned true on every path. A connection string is a credential;
accepting an unverified certificate hands it to whoever answers.

CockroachDB Cloud Basic clusters present a publicly-trusted certificate, so deployment needs
no CA file. Dedicated and self-hosted clusters can supply a private CA by path or inline.

## Provenance as a control

Every fact carries `source` and `confidence`, and the payout path reads them under
`FOR UPDATE` inside the transaction that writes the ledger row. A destination asserted by an
untrusted source is recorded and refused. See [decision 0005](decisions/0005-record-then-refuse.md).

## Known gaps

- The trust floor gates payouts, not every read. Other reads return facts of any provenance
  and leave the judgement to the caller.
- Secrets live in the build artifact and rotate only on redeploy.
- There is no rate limiting on the console's write endpoints. It is a demonstration on a
  capped cluster, not a service.
