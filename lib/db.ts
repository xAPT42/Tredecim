import pg, { Pool, type PoolClient } from 'pg'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// CockroachDB's INT is 64-bit, so node-postgres hands back strings to avoid silently
// truncating values beyond 2^53. Every integer in this schema — versions, counts, cents —
// is far inside the safe range, and comparing "1" to 1 is a bug waiting to happen.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error(`INT8 ${v} exceeds safe integer range`)
  return n
})

/**
 * TLS for the cluster.
 *
 * CockroachDB Cloud Basic clusters present a publicly-trusted certificate, so the system
 * trust store is enough and deployment needs no cert file. Dedicated and self-hosted
 * clusters use a private CA, which can be supplied either as a file (the path ccloud
 * writes to) or inline for environments without a home directory.
 *
 * `rejectUnauthorized` is pinned true in both branches. A connection string is a
 * credential; accepting an unverified certificate would hand it to whoever answers.
 */
function tlsConfig() {
  const inline = process.env.COCKROACH_CA_PEM
  if (inline) return { ca: inline, rejectUnauthorized: true }

  // os.homedir() throws in some serverless sandboxes where HOME is unset, and a missing
  // cert file is not an error worth crashing on — the system trust store covers Basic
  // clusters. Failing to read it must not take down the whole route.
  try {
    const local = path.join(os.homedir(), '.postgresql', 'root.crt')
    if (fs.existsSync(local)) {
      return { ca: fs.readFileSync(local, 'utf8'), rejectUnauthorized: true }
    }
  } catch {
    /* fall through to the system trust store */
  }

  return { rejectUnauthorized: true }
}

const globalForPool = globalThis as unknown as { tredecimPool?: Pool }

export const pool =
  globalForPool.tredecimPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: tlsConfig(),
    // Serverless invocations should hold as few connections as possible, so the default
    // is deliberately small. It has a consequence worth knowing: assertFact holds its
    // connection while waiting on FOR UPDATE, so N concurrent revisions of the same fact
    // need N connections. Past the pool size, writers queue at the pool rather than at
    // the database and can time out there — which looks like a contention failure and is
    // not one. Batch work (scripts/bench.ts, scripts/verify.ts) raises this.
    max: Number(process.env.PG_POOL_MAX ?? 4),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  })

if (process.env.NODE_ENV !== 'production') globalForPool.tredecimPool = pool

export type TxResult<T> = { value: T; latencyMs: number; retries: number }

/**
 * Run a serializable transaction, retrying on 40001 (serialization failure).
 *
 * CockroachDB defaults to SERIALIZABLE, so concurrent agents touching the same
 * memory will genuinely conflict rather than silently interleave. Retrying is the
 * correct response to 40001 — the transaction is replayed against fresh state, not
 * forced through. Every attempt is recorded so the console can show the aborts.
 */
export async function tx<T>(
  label: string,
  fn: (c: PoolClient) => Promise<T>,
  opts: { episodeId?: string; entityId?: string; maxRetries?: number } = {},
): Promise<TxResult<T>> {
  const maxRetries = opts.maxRetries ?? 5
  const started = performance.now()
  let retries = 0

  for (;;) {
    const client = await pool.connect()
    const attemptStart = performance.now()

    // The outcome is recorded *after* the connection goes back to the pool. Journalling
    // while still holding it takes a second connection from the same pool, so N concurrent
    // writers need 2N connections — and past the pool size that is a circular wait, with
    // every writer blocked on a connection only another writer's journal write can free.
    // The demo fires eight agents against a pool of four, so this is not theoretical.
    let outcome: { status: string; code: string | null; detail: string | null; ms: number } | null = null
    let result: TxResult<T> | undefined
    let failure: unknown
    let retrying = false

    try {
      await client.query('BEGIN')
      const value = await fn(client)
      await client.query('COMMIT')
      outcome = { status: 'commit', code: null, detail: null, ms: performance.now() - attemptStart }
      result = { value, latencyMs: performance.now() - started, retries }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      const e = err as { code?: string; message?: string }
      const ms = performance.now() - attemptStart

      // 40001 = serialization failure. Retryable by definition.
      if (e.code === '40001' && retries < maxRetries) {
        retries++
        retrying = true
        outcome = { status: 'retry', code: e.code, detail: e.message ?? null, ms }
      } else {
        outcome = { status: 'abort', code: e.code ?? null, detail: e.message ?? null, ms }
        failure = err
      }
    } finally {
      client.release()
    }

    if (outcome) await journal(label, outcome.status, outcome.code, outcome.detail, outcome.ms, opts)

    if (result) return result
    if (retrying) {
      // Exponential backoff with jitter, per CockroachDB guidance.
      const backoff = Math.min(2 ** retries * 20, 500) * (0.5 + Math.random())
      await new Promise((r) => setTimeout(r, backoff))
      continue
    }
    throw failure
  }
}

/** Fire-and-forget observability write. Never allowed to break the caller. */
async function journal(
  label: string,
  status: string,
  pgCode: string | null,
  detail: string | null,
  latencyMs: number,
  opts: { episodeId?: string; entityId?: string },
) {
  try {
    await pool.query(
      `INSERT INTO tx_journal (episode_id, entity_id, label, status, pg_code, detail, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [opts.episodeId ?? null, opts.entityId ?? null, label, status,
       pgCode, detail?.slice(0, 300) ?? null, latencyMs],
    )
  } catch {
    /* observability must never take down the agent */
  }
}
