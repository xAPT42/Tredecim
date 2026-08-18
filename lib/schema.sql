-- TREDECIM, bitemporal agent memory
--
-- Two temporal axes:
--   valid time     , when the fact is true in the world (modelled here)
--   transaction time, when the system learned it (recorded_at + MVCC / AS OF SYSTEM TIME)
--
-- Embeddings live on the fact rows themselves, not in a separate store. That is the
-- point: semantic recall and temporal validity are enforced by the same engine, in the
-- same transaction, so a similarity search can never surface a fact that has been closed.

-- ---------------------------------------------------------------- business state
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         STRING      NOT NULL,
  balance_cents INT8        NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger of money actually moved. Written in the SAME transaction as the memory
-- revision that justifies it, so business state and agent belief can never diverge.
CREATE TABLE IF NOT EXISTS ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID        NOT NULL REFERENCES accounts(id),
  amount_cents   INT8        NOT NULL,
  kind           STRING      NOT NULL,
  idempotency_key STRING     NOT NULL,
  episode_id     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same refund request must never pay out twice, even from two agents racing.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_idempotency
  ON ledger (idempotency_key);

-- ---------------------------------------------------------------- the memory
CREATE TABLE IF NOT EXISTS facts (
  entity_id   UUID         NOT NULL,
  key         STRING       NOT NULL,
  version     INT8         NOT NULL,

  value       JSONB        NOT NULL,
  statement   STRING       NOT NULL,          -- natural-language form, what gets embedded

  -- valid time: when this is true in the world
  valid_from  TIMESTAMPTZ  NOT NULL,
  valid_to    TIMESTAMPTZ,                    -- NULL = still in force, the open interval

  -- transaction time: when we learned it. MVCC gives us the engine-side axis,
  -- this column keeps it readable and durable past the GC horizon.
  recorded_at TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- provenance. Not all memories deserve equal trust.
  source      STRING       NOT NULL,          -- tool_verified | user_asserted | inferred
  confidence  FLOAT8       NOT NULL DEFAULT 1.0,
  superseded_by INT8,                         -- version that closed this one

  embedding   VECTOR(1024),

  PRIMARY KEY (entity_id, key, version),

  -- An interval that ends before it starts is not a fact, it is corruption. Backdated
  -- corrections are a legitimate use of valid_from, so the ordering is enforced here
  -- rather than trusted to every future caller.
  CONSTRAINT facts_interval_ordered CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- THE INVARIANT. At most one open fact per (entity, key).
-- Enforced by the storage engine, not by application code: an agent that tries to
-- assert a second truth without closing the first is rejected by the database.
CREATE UNIQUE INDEX IF NOT EXISTS facts_one_open
  ON facts (entity_id, key)
  WHERE valid_to IS NULL;

-- Point-in-time lookups: "what was true at T"
CREATE INDEX IF NOT EXISTS facts_valid_window
  ON facts (entity_id, key, valid_from DESC);

-- Distributed vector index (C-SPANN), partial over the facts currently in force.
--
-- Two things had to line up before the planner would use this, and each failed silently:
--
--   1. The operator class must match the operator the query uses. The default is
--      vector_l2_ops, which serves <-> only, while semanticRecall ranks by cosine <=>.
--      An index left at the default is built, listed by SHOW INDEXES, and never chosen.
--
--   2. A full index is not usable under the `valid_to IS NULL` predicate that every live
--      recall carries, the filter alone was enough to send the planner back to a scan.
--      Restricting the index to the same predicate is what makes it applicable.
--
-- The restriction is not a workaround, it is the right shape: only open facts are ever
-- semantically recalled, so the index tracks the size of the present rather than the size
-- of the history. Retaining every superseded interval costs storage, and costs the search
-- nothing. Historical recall (`asOf`) carries a different predicate and still scans; that
-- path is analytical and rare, and the README says so.
--
-- scripts/verify.ts asserts the plan, because both failures above look like success.
CREATE VECTOR INDEX IF NOT EXISTS facts_live_embedding_idx
  ON facts (embedding vector_cosine_ops)
  WHERE valid_to IS NULL;

-- ---------------------------------------------------------------- agent execution
-- An episode is one durable run of the agent. Every step is checkpointed, so a
-- process killed mid-flight resumes exactly where it stopped instead of redoing work.
CREATE TABLE IF NOT EXISTS episodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID        NOT NULL,
  entity_id     UUID        NOT NULL,
  goal          STRING      NOT NULL,
  status        STRING      NOT NULL DEFAULT 'running',  -- running | done | failed
  step          STRING      NOT NULL DEFAULT 'recall',   -- recall|decide|act|done
  scratch       JSONB       NOT NULL DEFAULT '{}',       -- durable working state
  outcome       JSONB,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS episodes_resumable
  ON episodes (status, updated_at DESC);

-- Inbound events the agent reacts to.
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   UUID        NOT NULL,
  kind        STRING      NOT NULL,
  payload     JSONB       NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS events_recent
  ON events (received_at DESC);

-- Observability: every transaction the agent attempts, including the ones the
-- database refuses. The aborts are the interesting rows.
CREATE TABLE IF NOT EXISTS tx_journal (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id  UUID,
  -- Attributed directly rather than inferred from timestamps: episode-less writes (a
  -- seed, a migration, another account's verification run) are otherwise indistinguishable.
  entity_id   UUID,
  label       STRING      NOT NULL,
  status      STRING      NOT NULL,          -- commit | abort | retry
  pg_code     STRING,
  detail      STRING,
  latency_ms  FLOAT8      NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tx_journal_recent
  ON tx_journal (at DESC);

-- Row-level TTL, applied here and deliberately nowhere else.
--
-- The journal is observability: a week of it answers every question anyone asks of it, and
-- nothing in the system reads a row older than that. Expiring it is straightforwardly
-- correct, and CockroachDB does the work, no scheduled cleanup job to write, monitor and
-- forget about.
--
-- `facts` gets no TTL. Retaining every superseded interval is the whole claim, and the
-- partial vector index already means history costs storage rather than query time. A
-- deployment with a real retention obligation would attach a TTL to facts closed beyond
-- its horizon, using exactly this mechanism; that is a policy decision belonging to
-- whoever owns the data, not a default worth shipping.


-- ---------------------------------------------------------------- in-place upgrades
-- CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so columns and constraints
-- added after a cluster was first provisioned need stating separately. Both forms below
-- are idempotent, which keeps `npm run migrate` safe to re-run.

ALTER TABLE tx_journal ADD COLUMN IF NOT EXISTS entity_id UUID;

ALTER TABLE tx_journal SET (
  ttl_expiration_expression = $$ (at + INTERVAL '7 days') $$,
  ttl_job_cron = '@daily'
);

CREATE INDEX IF NOT EXISTS tx_journal_by_entity
  ON tx_journal (entity_id, at DESC);

ALTER TABLE facts ADD CONSTRAINT IF NOT EXISTS facts_interval_ordered
  CHECK (valid_to IS NULL OR valid_to > valid_from);
