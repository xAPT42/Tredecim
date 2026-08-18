import { NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { lifeline } from '@/lib/memory'
import { DEMO_ACCOUNT } from '@/lib/demo'
import { activeProvider } from '@/lib/embeddings'

export const dynamic = 'force-dynamic'

/** Everything the console draws, in one round trip. */
export async function GET() {
  try {
    return await readState()
  } catch (err) {
    // A console that silently shows zeros when it cannot reach the memory is worse than
    // one that says so. Report the failure with enough detail to act on, and without the
    // connection string that may be embedded in driver errors.
    const e = err as { message?: string; code?: string }
    console.error('[state] failed:', e.code, e.message)
    return NextResponse.json(
      {
        error: 'cannot reach the memory',
        code: e.code ?? null,
        detail: (e.message ?? 'unknown').replace(/postgresql:\/\/[^\s]*/g, '[redacted]'),
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        provider: activeProvider(),
      },
      { status: 503 },
    )
  }
}

async function readState() {
  const [facts, events, journal, account, latency] = await Promise.all([
    lifeline(DEMO_ACCOUNT),

    pool.query(
      `SELECT id, kind, payload, received_at AS "receivedAt", handled_at AS "handledAt"
         FROM events WHERE entity_id = $1 ORDER BY received_at DESC LIMIT 12`,
      [DEMO_ACCOUNT],
    ),

    // Attributed by entity rather than inferred from timing: a verification run against
    // its own throwaway accounts used to surface here as if it were demo traffic.
    pool.query(
      `SELECT j.id, j.label, j.status, j.pg_code AS "pgCode", j.latency_ms AS "latencyMs", j.at
         FROM tx_journal j
         LEFT JOIN episodes e ON e.id = j.episode_id
        WHERE j.entity_id = $1 OR e.entity_id = $1
        ORDER BY j.at DESC LIMIT 14`,
      [DEMO_ACCOUNT],
    ),

    pool.query(
      // sum() yields DECIMAL, which the driver hands back as a string; cast it back.
      `SELECT balance_cents AS "balanceCents",
              (SELECT coalesce(sum(abs(amount_cents)),0)::INT8 FROM ledger WHERE account_id = $1)
                AS "movedCents",
              (SELECT count(*)::INT FROM ledger WHERE account_id = $1) AS "payouts"
         FROM accounts WHERE id = $1`,
      [DEMO_ACCOUNT],
    ),

    // Scoped to this account, and measured over the most recent commits rather than a
    // wall-clock window. Both matter: a fixed window reports a confident 0 ms whenever the
    // demo has been idle, and an unscoped one mixes in writes from a laptop in Europe,
    // whose transatlantic round-trip swamps the figure the console claims to be showing.
    pool.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
              count(*)::INT AS n
         FROM (SELECT j.latency_ms
                 FROM tx_journal j
                 LEFT JOIN episodes e ON e.id = j.episode_id
                WHERE j.status = 'commit'
                  AND (j.entity_id = $1 OR e.entity_id = $1)
                ORDER BY j.at DESC LIMIT 30)`,
      [DEMO_ACCOUNT],
    ),
  ])

  // A burst of concurrent agents writes the same refusal dozens of times. Showing each
  // one buries the rest of the journal, so runs of identical outcomes collapse into a
  // single row carrying its count — the number is the interesting part, not the repetition.
  const journalRows = collapseRuns(journal.rows as JournalRow[])
  const refused = journal.rows.filter((r) => r.status === 'abort').length

  return NextResponse.json({
    now: new Date().toISOString(),
    provider: activeProvider(),
    facts,
    events: events.rows,
    journal: journalRows,
    account: account.rows[0] ?? { balanceCents: 0, movedCents: 0, payouts: 0 },
    metrics: {
      closedFacts: facts.filter((f) => f.validTo !== null).length,
      openFacts: facts.filter((f) => f.validTo === null).length,
      refusedWrites: refused,
      // null rather than 0 when nothing has been measured — the console renders a dash.
      p50CommitMs: latency.rows[0]?.n ? Number(latency.rows[0].p50) : null,
    },
  })
}

type JournalRow = {
  id: string
  label: string
  status: string
  pgCode: string | null
  latencyMs: number
  at: string
}

function collapseRuns(rows: JournalRow[]): (JournalRow & { repeats: number })[] {
  const out: (JournalRow & { repeats: number })[] = []
  for (const row of rows) {
    const last = out.at(-1)
    if (last && last.label === row.label && last.status === row.status && last.pgCode === row.pgCode) {
      last.repeats++
    } else {
      out.push({ ...row, repeats: 1 })
    }
  }
  return out
}
