import type { PoolClient } from 'pg'
import { pool, tx } from './db'
import { embed } from './embeddings'

export type Source = 'tool_verified' | 'user_asserted' | 'inferred'

export type Fact = {
  entityId: string
  key: string
  version: number
  value: unknown
  statement: string
  validFrom: string
  validTo: string | null
  recordedAt: string
  source: Source
  confidence: number
  supersededBy: number | null
}

const SELECT_FACT = `
  entity_id AS "entityId", key, version::INT AS version, value, statement,
  valid_from AS "validFrom", valid_to AS "validTo", recorded_at AS "recordedAt",
  source, confidence, superseded_by::INT AS "supersededBy"
`

/**
 * Revise a fact.
 *
 * Closes the currently-open interval and opens a new one, in a single serializable
 * transaction. Either both happen or neither does, there is no instant at which the
 * entity has two IBANs, and no instant at which it has none.
 *
 * The partial unique index on (entity_id, key) WHERE valid_to IS NULL is what actually
 * guarantees this. If a concurrent agent opens a competing interval, the second writer
 * gets a constraint violation rather than a corrupted memory.
 */
export async function assertFact(
  entityId: string,
  key: string,
  value: unknown,
  statement: string,
  opts: {
    source?: Source
    confidence?: number
    validFrom?: Date
    episodeId?: string
    /** extra work committed atomically alongside the memory revision */
    alongside?: (c: PoolClient) => Promise<void>
  } = {}) {
  const vector = await embed(statement)
  const source = opts.source ?? 'tool_verified'
  const confidence = opts.confidence ?? 1.0

  return tx(
    `assert:${key}`,
    async (c) => {
      const prev = await c.query<{ version: number; validFrom: Date }>(
        `SELECT version::INT AS version, valid_from AS "validFrom" FROM facts
          WHERE entity_id = $1 AND key = $2 AND valid_to IS NULL
          FOR UPDATE`,
        [entityId, key])

      // Two revisions landing inside the same clock tick would close an interval at the
      // instant it opened, and a zero-length interval is not a fact, the CHECK constraint
      // rejects it, which under contention turned into lost writes rather than a queue.
      // Advancing past the previous start keeps every interval strictly ordered, so
      // concurrent writers serialise instead of failing.
      let now = opts.validFrom ?? new Date()
      const previousStart = prev.rows[0]?.validFrom
      if (previousStart && now <= previousStart) {
        now = new Date(previousStart.getTime() + 1)
      }

      const nextVersion = prev.rows.length ? prev.rows[0].version + 1 : 1

      if (prev.rows.length) {
        // Close the open interval. The row survives, nothing is ever deleted.
        await c.query(
          `UPDATE facts SET valid_to = $3, superseded_by = $4
            WHERE entity_id = $1 AND key = $2 AND valid_to IS NULL`,
          [entityId, key, now, nextVersion])
      }

      await c.query(
        `INSERT INTO facts
           (entity_id, key, version, value, statement, valid_from, valid_to,
            source, confidence, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)`,
        [
          entityId, key, nextVersion, JSON.stringify(value), statement,
          now, source, confidence, toVector(vector),
        ])

      // Business writes ride along in the same transaction. This is the whole
      // argument for keeping memory in the database the application already uses.
      if (opts.alongside) await opts.alongside(c)

      return { version: nextVersion, closedPrevious: prev.rows.length > 0 }
    },
    { episodeId: opts.episodeId, entityId })
}

/** Facts currently in force. */
export async function recallNow(entityId: string): Promise<Fact[]> {
  const r = await pool.query<Fact>(
    `SELECT ${SELECT_FACT} FROM facts
      WHERE entity_id = $1 AND valid_to IS NULL
      ORDER BY key`,
    [entityId])
  return r.rows
}

/**
 * Valid-time travel: what was true in the world at instant T.
 * Answers "what was the IBAN at 14:02", regardless of when we found out.
 */
export async function recallAt(entityId: string, at: Date): Promise<Fact[]> {
  const r = await pool.query<Fact>(
    `SELECT ${SELECT_FACT} FROM facts
      WHERE entity_id = $1
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY key`,
    [entityId, at])
  return r.rows
}

/**
 * Transaction-time travel: what the agent *believed* at instant T.
 * Uses recorded_at, which survives past the MVCC garbage-collection horizon and so
 * remains auditable indefinitely.
 */
export async function recallAsKnownAt(entityId: string, at: Date): Promise<Fact[]> {
  const r = await pool.query<Fact>(
    `SELECT ${SELECT_FACT} FROM facts
      WHERE entity_id = $1
        AND recorded_at <= $2
        AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2)
      ORDER BY key`,
    [entityId, at])
  return r.rows
}

/**
 * The same question answered by the storage engine itself, via MVCC.
 * Independent of our columns, it reads the cluster as it physically was.
 * Bounded by the zone's gc.ttlseconds, so it is a live-demo instrument rather than
 * the durable audit path.
 */
export async function recallViaMVCC(entityId: string, secondsAgo: number): Promise<Fact[]> {
  const r = await pool.query<Fact>(
    `SELECT ${SELECT_FACT} FROM facts
      AS OF SYSTEM TIME '-${Math.max(1, Math.floor(secondsAgo))}s'
      WHERE entity_id = $1 AND valid_to IS NULL
      ORDER BY key`,
    [entityId])
  return r.rows
}

/**
 * Semantic recall that cannot return a stale fact.
 *
 * A standalone vector store ranks by similarity alone, so a superseded IBAN with a
 * high cosine score comes back looking authoritative. Here the validity predicate and
 * the distance ordering are evaluated together by one engine, and `asOf` moves the
 * whole search back in time, similarity restricted to what was true then.
 */
export async function semanticRecall(
  query: string,
  opts: { entityId?: string; limit?: number; asOf?: Date; minConfidence?: number } = {}): Promise<(Fact & { distance: number })[]> {
  const vector = toVector(await embed(query))
  const limit = opts.limit ?? 5
  const params: unknown[] = [vector, limit]
  const where: string[] = []

  if (opts.asOf) {
    params.push(opts.asOf)
    where.push(`valid_from <= $${params.length} AND (valid_to IS NULL OR valid_to > $${params.length})`)
  } else {
    where.push('valid_to IS NULL')
  }
  if (opts.entityId) {
    params.push(opts.entityId)
    where.push(`entity_id = $${params.length}`)
  }
  if (opts.minConfidence != null) {
    params.push(opts.minConfidence)
    where.push(`confidence >= $${params.length}`)
  }

  const r = await pool.query<Fact & { distance: number }>(
    `SELECT ${SELECT_FACT}, embedding <=> $1 AS distance
       FROM facts
      WHERE ${where.join(' AND ')}
      ORDER BY distance
      LIMIT $2`,
    params)
  return r.rows
}

/** Every interval for an entity, what the console draws as the lifeline. */
export async function lifeline(entityId: string): Promise<Fact[]> {
  const r = await pool.query<Fact>(
    `SELECT ${SELECT_FACT} FROM facts
      WHERE entity_id = $1
      ORDER BY key, version`,
    [entityId])
  return r.rows
}

/** pgvector wire format. */
function toVector(v: number[]): string {
  return `[${v.join(',')}]`
}
