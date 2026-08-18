# CockroachDB Managed MCP Server

The cluster exposes a Model Context Protocol endpoint, which is how the schema in this
repository was inspected and iterated on: an agent connected to the live cluster, reading
real column types and index definitions rather than guessing from documentation.

## Connecting

CockroachDB Cloud → your cluster → **Connect** → **Model Context Protocol (MCP)** gives a
ready-made configuration block. Most MCP clients take the same shape:

```jsonc
{
  "mcpServers": {
    "cockroachdb": {
      "url": "https://cockroachlabs.cloud/api/mcp/v1/clusters/<CLUSTER_ID>",
      "headers": { "Authorization": "Bearer <SERVICE_ACCOUNT_TOKEN>" }
    }
  }
}
```

Create the token under **Governance → Service accounts**. Scope it to the single cluster;
a token that can reach every cluster in the organisation is a token you have to treat as a
production secret forever.

## What it was used for here

- Confirming that `VECTOR(n)`, the `<=>` cosine operator and `CREATE VECTOR INDEX` exist on
  this cluster version (v26.2.5) before the schema depended on them
- Reading `SHOW ZONE CONFIGURATION` to find the real `gc.ttlseconds`, which bounds how far
  back `AS OF SYSTEM TIME` can read. The default turned out to be 4500s, 75 minutes, not
  the day the documentation had led us to assume. Raised to 86400s for the demo, and the
  `recorded_at` column exists precisely because the MVCC horizon is finite and audit is not
- Checking that the partial unique index genuinely rejects a second open interval, rather
  than trusting that CockroachDB implements partial indexes the way PostgreSQL does

## What it became: a drift detector

Inspection during development was useful, but it is not an integration, it left the
project depending on a schema nobody re-checked. `npm run schema-check` turns that
inspection into something that runs on demand and fails.

It reads three sources and refuses to agree when they disagree: what `lib/schema.sql`
declares, what the TypeScript depends on, and **what the cluster actually holds**. That
last one is the point. Both of the most expensive bugs in this project were schema bugs
invisible in the DDL an application ships and visible only in the DDL a cluster holds:

```
[3] facts_live_embedding_idx can actually serve semanticRecall
  PASS  it is a VECTOR index, access method: cspann
  PASS  it uses vector_cosine_ops
  PASS  it is partial on WHERE valid_to IS NULL
  PASS  no index on facts is hidden from the optimiser

[6] The live recall plan does not fall back to a full scan
  PASS  no full scan in the plan
  PASS  the vector index serves the query
  PASS  and it is the partial index that serves it
```

An index built with the default operator class, or built full where the query needs a
partial one, passes every functional test and silently costs a scan per query. Checking the
plan is the only way to see it, and now something checks it.

## Why the hot path does not go through MCP

The application connects over the regular PostgreSQL wire protocol with a scoped SQL user.
MCP is a development and operations surface, excellent for letting an agent inspect a
cluster it does not own a driver for, and the wrong place to put a query that runs on every
refund. `schema-check` uses the same governed read path over SQL when no service-account
token is present, and reports which path it took rather than implying one it did not use.
