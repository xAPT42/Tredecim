import type { PoolClient } from 'pg'
import { pool, tx } from './db'
import { assertFact, lifeline, recallNow } from './memory'
import { handleEvent, startEpisode, runEpisode, resumeOrphaned } from './agent'

/** One stable account so the console always has something to show. */
export const DEMO_ACCOUNT = '13000000-0000-4000-8000-000000000013'

export async function reset() {
  await pool.query(`DELETE FROM ledger      WHERE account_id = $1`, [DEMO_ACCOUNT])
  await pool.query(`DELETE FROM facts       WHERE entity_id  = $1`, [DEMO_ACCOUNT])
  await pool.query(`DELETE FROM events      WHERE entity_id  = $1`, [DEMO_ACCOUNT])
  await pool.query(
    `DELETE FROM tx_journal WHERE episode_id IN (SELECT id FROM episodes WHERE entity_id = $1)`,
    [DEMO_ACCOUNT],
  )
  await pool.query(`DELETE FROM episodes    WHERE entity_id  = $1`, [DEMO_ACCOUNT])
  await pool.query(
    `UPSERT INTO accounts (id, label, balance_cents) VALUES ($1, 'Demo account 88', 100000)`,
    [DEMO_ACCOUNT],
  )

  // A short backdated history so the lifeline has real intervals to draw from the start.
  const now = Date.now()
  await assertFact(DEMO_ACCOUNT, 'iban', 'FR14…9001', 'Destination account is FR14…9001', {
    validFrom: new Date(now - 22 * 60_000),
  })
  await assertFact(DEMO_ACCOUNT, 'balance', 100000, 'Account balance is 1000.00 EUR', {
    validFrom: new Date(now - 22 * 60_000),
  })
  await assertFact(DEMO_ACCOUNT, 'kyc_tier', 'verified', 'Customer identity is verified', {
    validFrom: new Date(now - 20 * 60_000),
    source: 'tool_verified',
  })
}

export type ScenarioId =
  | 'supersede' | 'race' | 'crash' | 'stale-vector' | 'late-discovery' | 'poison'
  | 'async-window'

export async function runScenario(id: ScenarioId) {
  switch (id) {
    case 'supersede': {
      await handleEvent(DEMO_ACCOUNT, 'iban.changed', { iban: 'FR76…4412' })
      return { note: 'iban revised — the previous interval is now closed, not erased' }
    }

    case 'race': {
      const ev = await pool.query<{ id: string }>(
        `INSERT INTO events (entity_id, kind, payload)
         VALUES ($1,'refund.requested','{"amountCents":24000}') RETURNING id`,
        [DEMO_ACCOUNT],
      )
      const eventId = ev.rows[0].id
      const episodes = await Promise.all(
        Array.from({ length: 8 }, () =>
          startEpisode(eventId, DEMO_ACCOUNT, 'Refund 240.00 EUR', {
            kind: 'refund.requested',
            payload: { amountCents: 24000 },
          }),
        ),
      )
      const settled = await Promise.allSettled(episodes.map((e) => runEpisode(e)))
      const refused = settled.filter((s) => s.status === 'rejected').length
      const paid = await pool.query<{ n: number }>(
        `SELECT count(*)::INT AS n FROM ledger WHERE idempotency_key = $1`,
        [`refund:${eventId}`],
      )
      return { attempted: 8, refused, payouts: paid.rows[0].n }
    }

    case 'crash': {
      const ev = await pool.query<{ id: string }>(
        `INSERT INTO events (entity_id, kind, payload)
         VALUES ($1,'refund.requested','{"amountCents":15000}') RETURNING id`,
        [DEMO_ACCOUNT],
      )
      const episodeId = await startEpisode(ev.rows[0].id, DEMO_ACCOUNT, 'Refund 150.00 EUR', {
        kind: 'refund.requested',
        payload: { amountCents: 15000 },
      })
      // Park it exactly where a killed worker would have left it.
      await pool.query(
        `UPDATE episodes SET step='act', scratch = scratch || $2::JSONB WHERE id=$1`,
        [episodeId, JSON.stringify({
          decision: { action: 'refund', amountCents: 15000, destination: 'FR76…4412' },
        })],
      )
      const resumed = await resumeOrphaned(0)
      const paid = await pool.query<{ n: number }>(
        `SELECT count(*)::INT AS n FROM ledger WHERE episode_id=$1`, [episodeId],
      )
      return { episodeId, resumed: resumed.includes(episodeId), payouts: paid.rows[0].n }
    }

    case 'late-discovery': {
      // The two temporal axes only differ when the world moved before anyone noticed, so
      // the console needs a fact that was true for a while before it was recorded. A
      // dispute opened twelve minutes ago and is only being filed now: valid_from is
      // backdated, recorded_at is this instant. Rewind to ten minutes ago and the two
      // questions give different answers — which is the entire argument for keeping both.
      const openedAt = new Date(Date.now() - 12 * 60_000)
      await assertFact(
        DEMO_ACCOUNT,
        'chargeback',
        { status: 'open', ref: 'CB-7719', openedAt: openedAt.toISOString() },
        'A chargeback CB-7719 was opened against this account',
        { validFrom: openedAt, source: 'tool_verified' },
      )
      return {
        note: 'chargeback backdated 12 minutes, recorded now',
        tryThis: 'rewind to ~10 minutes ago: it was already true, and the agent did not know it',
      }
    }

    case 'poison': {
      // Memory poisoning: an untrusted actor writes a destination account into the agent's
      // memory and waits for some later, entirely innocent request to spend it. The plant
      // and the payout are separate episodes, minutes or weeks apart, which is what makes
      // this hard to see at the moment money moves — by then the poisoned fact is simply
      // what the memory says, indistinguishable from a fact the customer really changed.
      const ATTACKER_IBAN = 'FR99…8842'

      // Read the statement. It is word-for-word the shape a legitimate revision writes,
      // because an attacker chooses the text. Nothing in the sentence, and nothing its
      // embedding encodes, separates this from the truth — so the defence cannot live in
      // the text. It has to live in the metadata that travels beside it.
      const planted = await assertFact(
        DEMO_ACCOUNT,
        'iban',
        ATTACKER_IBAN,
        `Destination account is ${ATTACKER_IBAN}`,
        { source: 'user_asserted', confidence: 0.4 },
      )

      // The write succeeds, and that is correct. A memory that refuses to record what it
      // was told is a memory that has quietly decided what is true, and it loses the very
      // history needed to answer "when did this get in" afterwards. Recording and acting
      // are different questions.
      const intervals = (await lifeline(DEMO_ACCOUNT)).filter((f) => f.key === 'iban')
      const poisoned = intervals.find((f) => f.version === planted.value.version)!
      const displaced = intervals.find((f) => f.supersededBy === planted.value.version)

      const episode = await handleEvent(DEMO_ACCOUNT, 'refund.requested', { amountCents: 31000 })
      const outcome = (episode.outcome ?? {}) as {
        paid?: boolean; refused?: string; reason?: string
      }
      const paid = await pool.query<{ n: number }>(
        `SELECT count(*)::INT AS n FROM ledger WHERE episode_id = $1`, [episode.id],
      )

      return {
        asserted: {
          key: 'iban',
          value: ATTACKER_IBAN,
          statement: poisoned.statement,
          source: poisoned.source,
          confidence: poisoned.confidence,
          version: poisoned.version,
        },
        recorded: true,
        enteredAt: { validFrom: poisoned.validFrom, recordedAt: poisoned.recordedAt },
        superseded: displaced && {
          value: displaced.value,
          source: displaced.source,
          version: displaced.version,
          heldFrom: displaced.validFrom,
          closedAt: displaced.validTo,
        },
        refund: {
          amountCents: 31000,
          paid: outcome.paid === true,
          refused: outcome.refused ?? null,
          because: outcome.reason ?? null,
        },
        payouts: paid.rows[0].n,
        note: 'the memory accepted the revision; the policy refused to spend it',
        tryThis: 'rewind to before enteredAt: the trusted destination is still there, intact',
      }
    }

    case 'async-window':
      return measureAsyncWindow()

    case 'stale-vector': {
      const { semanticRecall } = await import('./memory')
      const live = await semanticRecall('where should the refund be sent', {
        entityId: DEMO_ACCOUNT, limit: 4,
      })
      const historical = await semanticRecall('where should the refund be sent', {
        entityId: DEMO_ACCOUNT, limit: 4, asOf: new Date(Date.now() - 10 * 60_000),
      })
      return {
        live: live.map((f) => ({ statement: f.statement, distance: f.distance })),
        tenMinutesAgo: historical.map((f) => ({ statement: f.statement, distance: f.distance })),
      }
    }
  }
}

// ---------------------------------------------------------------- the async window
//
// A memory layer can extract insights from a conversation after the fact, in a background
// pass, rather than on the request path. That is a reasonable design: the business write
// does not wait on an extraction, and the agent stays responsive under load. It has one
// consequence, and it is structural rather than a bug — between the business write and the
// memory that records it there is an interval in which the two disagree. The interval can
// be made short. It cannot be made zero, because it is the gap between two commits.
//
// What follows measures that interval instead of arguing about it: the same refund, run
// both ways against the live cluster, and the outcome read back from the database. The
// pieces are exported because scripts/verify.ts asserts them, and a comparison that is
// only ever run by its own demo is not evidence of anything.

/** The same refund amount down both paths, so the workload is identical. */
const WINDOW_AMOUNT_CENTS = 24000
const WINDOW_OPENING_CENTS = 100000

/**
 * Stands in for the worker process dying mid-write.
 *
 * A killed process drops its connection, and CockroachDB ends the open transaction
 * exactly as it ends one that raised: nothing committed. The state the database is left
 * holding is the same either way, and that state is all this measures.
 */
class WorkerDied extends Error {}

export type WindowMeasurement = {
  path: string
  label: string
  moneyMoved: boolean
  memoryRecords: boolean
  agrees: boolean
  ledgerRows: number
  debitedCents: number
  balanceCents: number
  memoryStatement: string | null
  explanation: string
}

export type AsyncWindowResult = {
  amountCents: number
  paths: WindowMeasurement[]
  control: WindowMeasurement
  note: string
}

/**
 * Path A — deferred extraction. The business write commits on its own, and the memory of
 * having made it is left to a later pass.
 *
 * That later pass is not stubbed, mocked or flagged off: this function returns after the
 * first commit, which is precisely what a process killed inside the window leaves behind.
 * The ledger row and the debit are real writes to the cluster, and the memory is really
 * absent, because nothing wrote it.
 */
export async function runDeferredExtraction(accountId: string) {
  const idempotencyKey = `refund:async-window:${accountId}`

  await tx(
    'async-window:business',
    async (c) => {
      await c.query(
        `INSERT INTO ledger (account_id, amount_cents, kind, idempotency_key)
         VALUES ($1, $2, 'refund', $3)`,
        [accountId, -WINDOW_AMOUNT_CENTS, idempotencyKey],
      )
      await c.query(
        `UPDATE accounts SET balance_cents = balance_cents - $2 WHERE id = $1`,
        [accountId, WINDOW_AMOUNT_CENTS],
      )
    },
    { entityId: accountId },
  )

  // Control returns here, inside the window. The extraction that would write `last_refund`
  // never runs.
  return { idempotencyKey }
}

/**
 * Path B — one transaction. The memory revision and the ledger write are the same commit,
 * which is what `assertFact(..., { alongside })` exists for.
 *
 * `killBeforeCommit` injects the failure at the same logical instant path A is interrupted
 * at: after the business write, before anything is durable. There is no window for it to
 * land in, so the abort takes the ledger write with it.
 */
export async function runSingleTransaction(
  accountId: string,
  opts: { killBeforeCommit?: boolean } = {},
) {
  const idempotencyKey = `refund:async-window:${accountId}`

  try {
    await assertFact(
      accountId,
      'last_refund',
      { amountCents: WINDOW_AMOUNT_CENTS, idempotencyKey },
      `Refund of ${(WINDOW_AMOUNT_CENTS / 100).toFixed(2)} EUR issued`,
      {
        source: 'tool_verified',
        alongside: async (c: PoolClient) => {
          await c.query(
            `INSERT INTO ledger (account_id, amount_cents, kind, idempotency_key)
             VALUES ($1, $2, 'refund', $3)`,
            [accountId, -WINDOW_AMOUNT_CENTS, idempotencyKey],
          )
          await c.query(
            `UPDATE accounts SET balance_cents = balance_cents - $2 WHERE id = $1`,
            [accountId, WINDOW_AMOUNT_CENTS],
          )
          if (opts.killBeforeCommit) throw new WorkerDied('worker died before commit')
        },
      },
    )
  } catch (err) {
    // Only the injected death is expected here. Anything else is a real failure and has to
    // reach the caller rather than be measured as an outcome.
    if (!(err instanceof WorkerDied)) throw err
  }

  return { idempotencyKey, killed: opts.killBeforeCommit === true }
}

/** Read both sides back from the cluster. Nothing here trusts what either path reported. */
async function measureWindow(
  accountId: string,
  path: string,
  label: string,
  explanation: string,
): Promise<WindowMeasurement> {
  const led = await pool.query<{ n: number; debited: number }>(
    `SELECT count(*)::INT AS n, coalesce(-sum(amount_cents), 0)::INT AS debited
       FROM ledger WHERE account_id = $1`,
    [accountId],
  )
  const bal = await pool.query<{ balanceCents: number }>(
    `SELECT balance_cents AS "balanceCents" FROM accounts WHERE id = $1`,
    [accountId],
  )
  const memory = (await recallNow(accountId)).find((f) => f.key === 'last_refund')

  const balanceCents = bal.rows[0].balanceCents
  const moneyMoved = led.rows[0].n > 0 && balanceCents < WINDOW_OPENING_CENTS
  const memoryRecords = memory !== undefined

  return {
    path,
    label,
    moneyMoved,
    memoryRecords,
    agrees: moneyMoved === memoryRecords,
    ledgerRows: led.rows[0].n,
    debitedCents: led.rows[0].debited,
    balanceCents,
    memoryStatement: memory?.statement ?? null,
    explanation,
  }
}

/**
 * Run the same refund down both paths and report what the database holds afterwards.
 *
 * Each path gets its own throwaway account so neither measurement can read the other's
 * rows, and so DEMO_ACCOUNT is never touched. Every row created here is removed again.
 */
export async function measureAsyncWindow(): Promise<AsyncWindowResult> {
  const deferred = await throwawayAccount('async-window deferred extraction')
  const single = await throwawayAccount('async-window one transaction')
  const killed = await throwawayAccount('async-window one transaction, killed')

  try {
    await runDeferredExtraction(deferred)
    await runSingleTransaction(single)
    await runSingleTransaction(killed, { killBeforeCommit: true })

    const a = await measureWindow(
      deferred,
      'A',
      'deferred extraction',
      'the ledger is debited and nothing in memory records it: the process stopped inside the window between the two writes',
    )
    const b = await measureWindow(
      single,
      'B',
      'one transaction',
      'a single commit carries both, so there is no instant at which the ledger and the memory disagree',
    )
    // The claim for path B is "both or neither", and a run that completes only shows the
    // first half. Interrupting it at the instant path A was interrupted at shows the other.
    const control = await measureWindow(
      killed,
      'B',
      'one transaction, interrupted at the same instant',
      'the abort took the ledger write down with the memory revision: no debit, no memory, still in agreement',
    )

    return {
      amountCents: WINDOW_AMOUNT_CENTS,
      paths: [a, b],
      control,
      note:
        'Deferred extraction keeps memory writes off the request path, which is a real benefit ' +
        'bought with a real window. The window can be made small; it cannot be made zero, ' +
        'because it is the gap between two commits. Measured here is only what each path ' +
        'leaves in the database when a process stops inside it.',
    }
  } finally {
    await discardAccounts([deferred, single, killed])
  }
}

async function throwawayAccount(label: string) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO accounts (label, balance_cents) VALUES ($1, $2) RETURNING id`,
    [label, WINDOW_OPENING_CENTS],
  )
  return r.rows[0].id
}

/** These accounts exist only for the length of one measurement, so nothing of them stays. */
async function discardAccounts(ids: string[]) {
  await pool.query(`DELETE FROM ledger     WHERE account_id = ANY($1::UUID[])`, [ids])
  await pool.query(`DELETE FROM facts      WHERE entity_id  = ANY($1::UUID[])`, [ids])
  await pool.query(`DELETE FROM tx_journal WHERE entity_id  = ANY($1::UUID[])`, [ids])
  await pool.query(`DELETE FROM accounts   WHERE id         = ANY($1::UUID[])`, [ids])
}
