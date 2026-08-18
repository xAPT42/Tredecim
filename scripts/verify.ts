import './_boot'
import { pool } from '../lib/db'
import {
  handleEvent, startEpisode, runEpisode, resumeOrphaned, PAYOUT_CONFIDENCE_FLOOR,
} from '../lib/agent'
import {
  assertFact, recallNow, recallAt, recallAsKnownAt, recallViaMVCC,
  semanticRecall, lifeline,
} from '../lib/memory'
import { activeProvider } from '../lib/embeddings'
import {
  DEMO_ACCOUNT, measureAsyncWindow, runDeferredExtraction, runSingleTransaction,
} from '../lib/demo'

/**
 * End-to-end proof of the four claims TREDECIM makes, run against a live cluster.
 * Exits non-zero if any of them fail, so it doubles as the CI gate.
 */

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function freshAccount(label: string) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO accounts (label, balance_cents) VALUES ($1, 100000) RETURNING id`,
    [label],
  )
  return r.rows[0].id
}

// ── 1 ────────────────────────────────────────────────────────────────────────
// The storage engine, not application code, forbids two simultaneous truths.
async function claimOneOpenInterval() {
  console.log('\n[1] At most one open interval per (entity, key)')
  const acct = await freshAccount('one-open')

  await assertFact(acct, 'iban', 'FR14…9001', 'Destination account is FR14…9001')
  await assertFact(acct, 'iban', 'FR76…4412', 'Destination account is FR76…4412')

  const open = await pool.query(
    `SELECT count(*)::INT AS n FROM facts WHERE entity_id=$1 AND key='iban' AND valid_to IS NULL`,
    [acct],
  )
  const all = await pool.query(
    `SELECT count(*)::INT AS n FROM facts WHERE entity_id=$1 AND key='iban'`,
    [acct],
  )
  check('exactly one interval left open', open.rows[0].n === 1)
  check('the superseded interval is retained, not deleted', all.rows[0].n === 2)

  // Now bypass the memory API and try to force a second open interval directly.
  let rejected = false
  try {
    await pool.query(
      `INSERT INTO facts (entity_id,key,version,value,statement,valid_from,source)
       VALUES ($1,'iban',99,'"FR99"','forced',now(),'inferred')`,
      [acct],
    )
  } catch (e) {
    rejected = (e as { code?: string }).code === '23505'
  }
  check('raw INSERT bypassing the API is rejected by the database', rejected)

  return acct
}

// ── 2 ────────────────────────────────────────────────────────────────────────
// Both temporal axes are queryable and disagree in the way they should.
async function claimBitemporal(acct: string) {
  console.log('\n[2] Valid time and transaction time are independently queryable')

  const t0 = new Date(Date.now() - 60_000)
  const t1 = new Date(Date.now() - 30_000)

  const acct2 = await freshAccount('bitemporal')
  await assertFact(acct2, 'iban', 'OLD', 'Destination account is OLD', { validFrom: t0 })
  await assertFact(acct2, 'iban', 'NEW', 'Destination account is NEW', { validFrom: t1 })

  const now = await recallNow(acct2)
  const then = await recallAt(acct2, new Date(t0.getTime() + 5_000))
  const known = await recallAsKnownAt(acct2, new Date(t0.getTime() + 5_000))

  check('current value is the open interval', now.find((f) => f.key === 'iban')?.value === 'NEW')
  check('valid-time lookup returns the value in force then',
    then.find((f) => f.key === 'iban')?.value === 'OLD')
  check('transaction-time lookup is empty — nothing was known yet at that instant',
    known.length === 0,
    `${known.length} facts`)

  const line = await lifeline(acct2)
  const closed = line.filter((f) => f.validTo !== null)
  check('closed interval records which version replaced it',
    closed.length === 1 && closed[0].supersededBy === 2)

  // MVCC gives the same answer from the engine's own history, with no columns involved.
  const viaEngine = await recallViaMVCC(acct2, 1)
  check('AS OF SYSTEM TIME reads the cluster as it physically was',
    viaEngine.find((f) => f.key === 'iban')?.value === 'NEW',
    `engine history says ${JSON.stringify(viaEngine.find((f) => f.key === 'iban')?.value)}`)

  return acct2
}

// ── 3 ────────────────────────────────────────────────────────────────────────
// Semantic search that cannot surface a superseded fact.
async function claimSemanticRespectsTime(acct: string) {
  console.log('\n[3] Vector recall is constrained by validity')

  const hits = await semanticRecall('where should the money be sent', { entityId: acct, limit: 5 })
  const values = hits.map((h) => h.value)

  check('similarity search returns the live destination', values.includes('NEW'))
  check('the superseded destination is unreachable despite matching text',
    !values.includes('OLD'),
    `returned ${JSON.stringify(values)}`)

  // The same query, rewound: similarity restricted to what was true back then.
  const past = await semanticRecall('where should the money be sent', {
    entityId: acct,
    asOf: new Date(Date.now() - 45_000),
  })
  check('the same query as-of an earlier instant returns the old destination',
    past.map((h) => h.value).includes('OLD'),
    `returned ${JSON.stringify(past.map((h) => h.value))}`)
}

// ── 4 ────────────────────────────────────────────────────────────────────────
// Concurrent agents racing the same refund. Exactly one payout survives.
async function claimNoDoublePayout() {
  console.log('\n[4] Concurrent agents cannot double-pay the same request')
  const acct = await freshAccount('race')
  await assertFact(acct, 'iban', 'FR76…4412', 'Destination account is FR76…4412')

  const ev = await pool.query<{ id: string }>(
    `INSERT INTO events (entity_id, kind, payload)
     VALUES ($1,'refund.requested','{"amountCents":24000}') RETURNING id`,
    [acct],
  )
  const eventId = ev.rows[0].id

  // Eight workers pick up the same event simultaneously.
  const episodes = await Promise.all(
    Array.from({ length: 8 }, () =>
      startEpisode(eventId, acct, 'Refund 240.00 EUR', {
        kind: 'refund.requested',
        payload: { amountCents: 24000 },
      }),
    ),
  )
  const results = await Promise.allSettled(episodes.map((id) => runEpisode(id)))

  const paid = await pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM ledger WHERE idempotency_key = $1`,
    [`refund:${eventId}`],
  )
  const balance = await pool.query<{ balance_cents: string }>(
    `SELECT balance_cents FROM accounts WHERE id = $1`, [acct],
  )
  const rejected = results.filter((r) => r.status === 'rejected').length

  check('exactly one ledger entry exists', paid.rows[0].n === 1, `${paid.rows[0].n} entries`)
  check('balance debited exactly once',
    Number(balance.rows[0].balance_cents) === 100000 - 24000,
    `${balance.rows[0].balance_cents} cents`)
  check('the losing agents were refused, not silently merged', rejected === 7, `${rejected}/7 refused`)

  const journal = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::INT AS n FROM tx_journal
      WHERE episode_id = ANY($1) GROUP BY status`,
    [episodes],
  )
  console.log(`        journal: ${journal.rows.map((r) => `${r.status}=${r.n}`).join(' ')}`)
}

// ── 5 ────────────────────────────────────────────────────────────────────────
// An episode killed mid-flight resumes from its checkpoint.
async function claimCrashRecovery() {
  console.log('\n[5] An episode killed mid-flight resumes where it stopped')
  const acct = await freshAccount('crash')
  await assertFact(acct, 'iban', 'FR76…4412', 'Destination account is FR76…4412')

  const ev = await pool.query<{ id: string }>(
    `INSERT INTO events (entity_id, kind, payload)
     VALUES ($1,'refund.requested','{"amountCents":15000}') RETURNING id`,
    [acct],
  )
  const episodeId = await startEpisode(ev.rows[0].id, acct, 'Refund 150.00 EUR', {
    kind: 'refund.requested',
    payload: { amountCents: 15000 },
  })

  // Simulate a worker that died after recalling and deciding, before acting.
  await pool.query(
    `UPDATE episodes SET step='act', scratch = scratch || $2::JSONB WHERE id=$1`,
    [episodeId, JSON.stringify({
      decision: { action: 'refund', amountCents: 15000, destination: 'FR76…4412' },
    })],
  )

  const before = await pool.query<{ step: string; status: string }>(
    `SELECT step, status FROM episodes WHERE id=$1`, [episodeId],
  )
  check('episode is parked at the act step', before.rows[0].step === 'act')

  const resumed = await resumeOrphaned(0)
  check('recovery sweep picked it up', resumed.includes(episodeId))

  const after = await pool.query<{ status: string; outcome: { paid?: boolean } }>(
    `SELECT status, outcome FROM episodes WHERE id=$1`, [episodeId],
  )
  const paid = await pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM ledger WHERE episode_id=$1`, [episodeId],
  )
  check('episode completed after recovery', after.rows[0].status === 'done')
  check('the payout happened exactly once', paid.rows[0].n === 1, `${paid.rows[0].n} entries`)
}

// ── 6 ────────────────────────────────────────────────────────────────────────
// Whole-agent path through the public API.
async function claimEndToEnd() {
  console.log('\n[6] Event to memory, end to end')
  const acct = await freshAccount('e2e')

  await handleEvent(acct, 'iban.changed', { iban: 'FR14…9001' })
  await handleEvent(acct, 'iban.changed', { iban: 'FR76…4412' })
  await handleEvent(acct, 'dispute.opened', { ref: 'D-1042' })
  const refund = await handleEvent(acct, 'refund.requested', { amountCents: 24000 })

  const facts = await recallNow(acct)
  const outcome = refund.outcome as { paid?: boolean; destination?: string }

  check('refund was paid', outcome?.paid === true)
  check('it went to the current destination, not the closed one',
    outcome?.destination === 'FR76…4412', String(outcome?.destination))
  check('memory holds iban, dispute and last_refund',
    ['iban', 'dispute', 'last_refund'].every((k) => facts.some((f) => f.key === k)),
    facts.map((f) => f.key).join(','))

  // A frozen account must stop the next payout, on the strength of memory alone.
  await handleEvent(acct, 'account.frozen', {})
  const blocked = await handleEvent(acct, 'refund.requested', { amountCents: 5000 })
  check('a later refund is refused because memory says the account is frozen',
    (blocked.outcome as { skipped?: boolean })?.skipped === true)
}

// ── 7 ────────────────────────────────────────────────────────────────────────
// The gap between deciding and acting is where a durable agent is most exposed.
async function claimDecisionRevalidated() {
  console.log('\n[7] A decision is re-validated against live memory before money moves')
  const acct = await freshAccount('stale-decision')
  await assertFact(acct, 'iban', 'OLD-DESTINATION', 'Destination account is OLD-DESTINATION')

  const ev = await pool.query<{ id: string }>(
    `INSERT INTO events (entity_id, kind, payload)
     VALUES ($1,'refund.requested','{"amountCents":20000}') RETURNING id`,
    [acct],
  )
  const episodeId = await startEpisode(ev.rows[0].id, acct, 'Refund 200.00 EUR', {
    kind: 'refund.requested',
    payload: { amountCents: 20000 },
  })

  // Park the episode exactly as a worker that decided and then died would leave it.
  await pool.query(
    `UPDATE episodes SET step='act', scratch = scratch || $2::JSONB WHERE id=$1`,
    [episodeId, JSON.stringify({
      decision: {
        action: 'refund', amountCents: 20000,
        destination: 'OLD-DESTINATION', destinationVersion: 1,
      },
    })],
  )

  // The customer changes their bank details while the episode is parked.
  await assertFact(acct, 'iban', 'NEW-DESTINATION', 'Destination account is NEW-DESTINATION')

  await runEpisode(episodeId)

  const paid = await pool.query<{ n: number; kind: string }>(
    `SELECT count(*)::INT AS n FROM ledger WHERE episode_id = $1`, [episodeId],
  )
  const outcome = await pool.query<{ outcome: { paid?: boolean; destination?: string } }>(
    `SELECT outcome FROM episodes WHERE id = $1`, [episodeId],
  )
  const facts = await recallNow(acct)

  check('the stale destination was never paid',
    outcome.rows[0].outcome?.destination !== 'OLD-DESTINATION',
    `paid to ${outcome.rows[0].outcome?.destination}`)
  check('the refund still went through, to the current destination',
    outcome.rows[0].outcome?.destination === 'NEW-DESTINATION')
  check('exactly one ledger entry', paid.rows[0].n === 1, `${paid.rows[0].n}`)
  check('memory reflects the payout to the live destination',
    facts.some((f) => f.key === 'last_refund'))

  // And the same guard must stop a payout entirely when the account is frozen after
  // the decision, rather than re-deciding into a payment.
  const acct2 = await freshAccount('frozen-after-decision')
  await assertFact(acct2, 'iban', 'DEST', 'Destination account is DEST')
  const ev2 = await pool.query<{ id: string }>(
    `INSERT INTO events (entity_id, kind, payload)
     VALUES ($1,'refund.requested','{"amountCents":9000}') RETURNING id`,
    [acct2],
  )
  const ep2 = await startEpisode(ev2.rows[0].id, acct2, 'Refund 90.00 EUR', {
    kind: 'refund.requested', payload: { amountCents: 9000 },
  })
  await pool.query(
    `UPDATE episodes SET step='act', scratch = scratch || $2::JSONB WHERE id=$1`,
    [ep2, JSON.stringify({
      decision: { action: 'refund', amountCents: 9000, destination: 'DEST', destinationVersion: 1 },
    })],
  )
  await assertFact(acct2, 'account_frozen', true, 'Account is frozen and cannot receive payouts')
  await runEpisode(ep2)

  const paid2 = await pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM ledger WHERE episode_id = $1`, [ep2],
  )
  check('a freeze landing after the decision blocks the payout', paid2.rows[0].n === 0,
    `${paid2.rows[0].n} entries`)
}

// ── 8 ────────────────────────────────────────────────────────────────────────
// An index that is built, reported by SHOW INDEXES, and never chosen by the planner
// looks exactly like a working one until someone reads a query plan.
async function claimVectorIndexIsUsed() {
  console.log('\n[8] The vector index actually serves the semantic query')

  const probe = `[${Array.from({ length: 1024 }, (_, i) => (i % 7) / 10).join(',')}]`
  const plan = await pool.query<{ info: string }>(
    `EXPLAIN SELECT statement FROM facts
      WHERE valid_to IS NULL ORDER BY embedding <=> $1 LIMIT 5`,
    [probe],
  )
  const text = plan.rows.map((r) => r.info).join('\n')

  check('the live recall path uses the index rather than scanning',
    !/FULL SCAN/.test(text),
    /FULL SCAN/.test(text) ? 'check the operator class and the partial predicate' : '')
  check('and it is the partial index that serves it', /partial index/.test(text))

  const ddl = await pool.query<{ create_statement: string }>(
    `SELECT create_statement FROM [SHOW CREATE TABLE facts]`,
  )
  const stmt = ddl.rows[0].create_statement
  check('declared with the cosine operator class',
    /vector_cosine_ops/.test(stmt),
    'semanticRecall ranks by <=>, which vector_l2_ops cannot serve')
  check('restricted to the facts in force',
    /facts_live_embedding_idx[\s\S]*?WHERE valid_to IS NULL/.test(stmt),
    'a full index is not applicable under the validity predicate')

  // Historical recall carries a different predicate and is expected to scan. Stating it
  // here keeps the limitation measured rather than discovered by a reviewer.
  const past = await pool.query<{ info: string }>(
    `EXPLAIN SELECT statement FROM facts
      WHERE valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
      ORDER BY embedding <=> $1 LIMIT 5`,
    [probe],
  )
  console.log(`        as-of recall plan: ${
    /FULL SCAN/.test(past.rows.map((r) => r.info).join('')) ? 'full scan (documented)' : 'indexed'
  }`)
}

// ── 9 ────────────────────────────────────────────────────────────────────────
// Rapid revisions of the same fact are the case where the interval arithmetic and the
// locking have to agree with each other.
async function claimRapidRevisions() {
  console.log('\n[9] Rapid concurrent revisions of one fact all land')
  const acct = await freshAccount('rapid')

  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      assertFact(acct, 'iban', `FR-${i}`, `Destination account is FR-${i}`)),
  )
  const committed = results.filter((r) => r.status === 'fulfilled').length
  const line = await lifeline(acct)
  const open = line.filter((f) => f.validTo === null).length

  // Two revisions inside one clock tick would close an interval at the instant it opened.
  const degenerate = line.filter(
    (f) => f.validTo !== null && new Date(f.validTo) <= new Date(f.validFrom),
  ).length

  check('every writer committed', committed === 12, `${committed}/12`)
  check('no zero-length interval was produced', degenerate === 0, `${degenerate} degenerate`)
  check('exactly one interval is left open', open === 1, `${open} open`)
  check('every revision is retained', line.length === 12, `${line.length} intervals`)
}

// ── 10 ───────────────────────────────────────────────────────────────────────
// Provenance is only worth recording if something reads it at the instant it matters.
// Memory poisoning is temporally decoupled: the hostile fact is planted in one episode and
// spent in another, so a check at write time sees a legitimate revision and a check at
// decision time can be outrun. It has to sit where the money moves.
async function claimTrustEnforced() {
  console.log('\n[10] Provenance is enforced where money moves, not merely recorded')

  const poisoned = await freshAccount('poisoned')
  await assertFact(poisoned, 'iban', 'TRUSTED-DEST', 'Destination account is TRUSTED-DEST')
  // Someone simply claims a new account number. The statement is the same sentence a real
  // revision writes — only the provenance differs, which is the entire point.
  await assertFact(poisoned, 'iban', 'ATTACKER-DEST', 'Destination account is ATTACKER-DEST', {
    source: 'user_asserted', confidence: 0.4,
  })

  const refused = await handleEvent(poisoned, 'refund.requested', { amountCents: 24000 })
  const out = (refused.outcome ?? {}) as {
    paid?: boolean; refused?: string; source?: string; destination?: string
  }
  const ledger = await pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM ledger WHERE account_id = $1`, [poisoned],
  )
  const balance = await pool.query<{ balance_cents: string }>(
    `SELECT balance_cents FROM accounts WHERE id = $1`, [poisoned],
  )

  check('a user_asserted destination is never paid to', out.paid !== true,
    `outcome paid=${out.paid} to ${out.destination}`)
  check('no ledger entry was written', ledger.rows[0].n === 0, `${ledger.rows[0].n} entries`)
  check('the balance is untouched', Number(balance.rows[0].balance_cents) === 100000)
  check('the refusal names the provenance that caused it',
    out.refused === 'untrusted_destination' && out.source === 'user_asserted',
    `${out.refused} / ${out.source}`)
  // The refusal happened inside the transaction that would have paid, so the agent also
  // has no memory of paying — the two roll back together or not at all.
  check('and the agent holds no memory of a refund it did not make',
    !(await recallNow(poisoned)).some((f) => f.key === 'last_refund'))

  // Recording and acting are different questions. Refusing to *record* the claim would
  // throw away the only evidence of the attack, so the fact is in memory — and the history
  // is what makes it answerable afterwards.
  const line = (await lifeline(poisoned)).filter((f) => f.key === 'iban')
  const open = line.find((f) => f.validTo === null)!
  const closed = line.find((f) => f.validTo !== null)!

  check('the poisoned fact IS recorded, not refused at the door',
    line.length === 2 && open.value === 'ATTACKER-DEST' && open.source === 'user_asserted',
    `${line.length} intervals, open=${JSON.stringify(open?.value)}`)
  check('history says when it entered and when the system learned it',
    Number.isFinite(new Date(open.validFrom).getTime()) &&
    Number.isFinite(new Date(open.recordedAt).getTime()),
    `entered ${new Date(open.validFrom).toISOString()}, recorded ${new Date(open.recordedAt).toISOString()}`)
  check('and exactly what it superseded',
    closed.value === 'TRUSTED-DEST' &&
    closed.source === 'tool_verified' &&
    closed.supersededBy === open.version,
    `v${closed.version} ${JSON.stringify(closed.value)} → v${closed.supersededBy}`)

  const before = await recallAt(poisoned, new Date(new Date(open.validFrom).getTime() - 1))
  check('rewinding to the instant before it entered still shows the trusted destination',
    before.find((f) => f.key === 'iban')?.value === 'TRUSTED-DEST',
    JSON.stringify(before.find((f) => f.key === 'iban')?.value))

  // A policy that refuses everything proves nothing. The same request against a
  // tool-verified destination has to go through untouched.
  const clean = await freshAccount('trusted-dest')
  await assertFact(clean, 'iban', 'VERIFIED-DEST', 'Destination account is VERIFIED-DEST')
  const paidEp = await handleEvent(clean, 'refund.requested', { amountCents: 24000 })
  const paidOut = (paidEp.outcome ?? {}) as { paid?: boolean; destination?: string }
  check('a tool_verified destination still pays normally',
    paidOut.paid === true && paidOut.destination === 'VERIFIED-DEST',
    `paid=${paidOut.paid} to ${paidOut.destination}`)

  // Source is not the whole policy. A tool that reports its own uncertainty — a fuzzy match
  // against a bank record, an OCR read of a mandate — is tool_verified and still not
  // evidence enough to move money.
  const hedged = await freshAccount('below-floor')
  await assertFact(hedged, 'iban', 'FUZZY-DEST', 'Destination account is FUZZY-DEST', {
    source: 'tool_verified', confidence: PAYOUT_CONFIDENCE_FLOOR - 0.05,
  })
  const hedgedEp = await handleEvent(hedged, 'refund.requested', { amountCents: 5000 })
  check('a tool_verified destination below the confidence floor is refused too',
    (hedgedEp.outcome as { paid?: boolean })?.paid !== true,
    `floor is ${PAYOUT_CONFIDENCE_FLOOR}`)

  // The case the whole design exists for: trusted when the decision was taken, untrusted by
  // the time the money moves. A check in decide() passes this one and pays the attacker.
  const parked = await freshAccount('poisoned-while-parked')
  await assertFact(parked, 'iban', 'TRUSTED-DEST', 'Destination account is TRUSTED-DEST')
  const ev = await pool.query<{ id: string }>(
    `INSERT INTO events (entity_id, kind, payload)
     VALUES ($1,'refund.requested','{"amountCents":20000}') RETURNING id`,
    [parked],
  )
  const episodeId = await startEpisode(ev.rows[0].id, parked, 'Refund 200.00 EUR', {
    kind: 'refund.requested', payload: { amountCents: 20000 },
  })
  await pool.query(
    `UPDATE episodes SET step='act', scratch = scratch || $2::JSONB WHERE id=$1`,
    [episodeId, JSON.stringify({
      decision: {
        action: 'refund', amountCents: 20000,
        destination: 'TRUSTED-DEST', destinationVersion: 1,
      },
    })],
  )
  // The poison lands while the episode is parked between deciding and acting.
  await assertFact(parked, 'iban', 'ATTACKER-DEST', 'Destination account is ATTACKER-DEST', {
    source: 'user_asserted', confidence: 0.4,
  })
  await runEpisode(episodeId)

  const parkedLedger = await pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM ledger WHERE account_id = $1`, [parked],
  )
  const parkedOut = await pool.query<{ outcome: { paid?: boolean; refused?: string } }>(
    `SELECT outcome FROM episodes WHERE id = $1`, [episodeId],
  )
  const aborted = await pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM tx_journal WHERE episode_id = $1 AND status = 'abort'`,
    [episodeId],
  )

  check('a fact trusted at decision time and superseded by an untrusted one is caught',
    parkedLedger.rows[0].n === 0, `${parkedLedger.rows[0].n} entries`)
  check('the episode ends refused rather than re-deciding its way into paying',
    parkedOut.rows[0].outcome?.paid !== true &&
    parkedOut.rows[0].outcome?.refused === 'untrusted_destination',
    JSON.stringify(parkedOut.rows[0].outcome))
  check('the refused transaction is on the audit trail, not silently dropped',
    aborted.rows[0].n >= 1, `${aborted.rows[0].n} aborts journalled`)
}

// ── 11 ───────────────────────────────────────────────────────────────────────
// Extracting memory in a background pass after the business write is a legitimate design:
// it keeps the memory write off the request path, and under load that is worth having. It
// also has a consequence worth measuring rather than debating — between the two commits
// the ledger and the memory disagree, and a process that stops in there leaves them that
// way. The same refund runs down both paths below, and every outcome is read out of the
// database by this script rather than taken from what either path reported.
async function claimMoneyAndMemoryCommitTogether() {
  console.log('\n[11] Money and the memory of it commit together, or not at all')

  const deferred = await freshAccount('deferred-extraction')
  await runDeferredExtraction(deferred)
  const a = await moneyAndMemory(deferred)

  check('deferred extraction: the money really moved', a.moneyMoved,
    `${a.ledgerRows} ledger rows, balance ${a.balanceCents}`)
  check('deferred extraction: nothing in memory records the refund', !a.memoryRecords)
  check('deferred extraction: the ledger and the memory disagree',
    a.moneyMoved !== a.memoryRecords,
    'the process stopped between the business write and the memory of it')

  const single = await freshAccount('one-transaction')
  await runSingleTransaction(single)
  const b = await moneyAndMemory(single)

  check('one transaction: the money moved', b.moneyMoved,
    `${b.ledgerRows} ledger rows, balance ${b.balanceCents}`)
  check('one transaction: memory records it', b.memoryRecords)
  check('one transaction: the two agree', b.moneyMoved === b.memoryRecords)

  // "Both or neither" is only half-shown by a run that completes. Interrupting the single
  // transaction at the instant the deferred path was interrupted at shows the other half.
  const killed = await freshAccount('one-transaction-killed')
  await runSingleTransaction(killed, { killBeforeCommit: true })
  const c = await moneyAndMemory(killed)

  check('interrupted before commit: no ledger entry', c.ledgerRows === 0, `${c.ledgerRows} rows`)
  check('interrupted before commit: the balance is untouched', c.balanceCents === 100000,
    `${c.balanceCents} cents`)
  check('interrupted before commit: no memory of a refund that did not happen',
    !c.memoryRecords)
  check('interrupted before commit: the two still agree', c.moneyMoved === c.memoryRecords)

  // The scenario the console runs is the thing under test, not a second copy of it — and
  // it must leave the demo account and the cluster exactly as it found them.
  const demoBefore = await demoFootprint()
  const measured = await measureAsyncWindow()
  const demoAfter = await demoFootprint()
  const [reportedA, reportedB] = measured.paths

  check('the scenario reports the deferred path as debited and unrecorded',
    reportedA.moneyMoved && !reportedA.memoryRecords && !reportedA.agrees,
    `moved=${reportedA.moneyMoved} recorded=${reportedA.memoryRecords}`)
  check('the scenario reports the single transaction as consistent',
    reportedB.moneyMoved && reportedB.memoryRecords && reportedB.agrees,
    `moved=${reportedB.moneyMoved} recorded=${reportedB.memoryRecords}`)
  check('and consistent again when it is interrupted before committing',
    !measured.control.moneyMoved && !measured.control.memoryRecords && measured.control.agrees,
    `moved=${measured.control.moneyMoved} recorded=${measured.control.memoryRecords}`)
  check('the scenario left none of its throwaway accounts behind',
    (await pool.query<{ n: number }>(
      `SELECT count(*)::INT AS n FROM accounts WHERE label LIKE 'async-window%'`,
    )).rows[0].n === 0)
  check('and did not touch the demo account', demoBefore === demoAfter,
    `${demoBefore} → ${demoAfter}`)
}

/** Read by this script directly, so the comparison rests on the database, not on lib/demo. */
async function moneyAndMemory(accountId: string) {
  const led = await pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM ledger WHERE account_id = $1`, [accountId],
  )
  const bal = await pool.query<{ balance_cents: number }>(
    `SELECT balance_cents FROM accounts WHERE id = $1`, [accountId],
  )
  const facts = await recallNow(accountId)
  const balanceCents = Number(bal.rows[0].balance_cents)

  return {
    ledgerRows: led.rows[0].n,
    balanceCents,
    moneyMoved: led.rows[0].n > 0 && balanceCents < 100000,
    memoryRecords: facts.some((f) => f.key === 'last_refund'),
  }
}

async function demoFootprint() {
  const r = await pool.query<{ ledger: number; facts: number }>(
    `SELECT (SELECT count(*)::INT FROM ledger WHERE account_id = $1) AS ledger,
            (SELECT count(*)::INT FROM facts  WHERE entity_id  = $1) AS facts`,
    [DEMO_ACCOUNT],
  )
  return `${r.rows[0].ledger} ledger / ${r.rows[0].facts} facts`
}

async function main() {
  console.log(`TREDECIM verification — embeddings: ${activeProvider()}`)
  const acct = await claimOneOpenInterval()
  const acct2 = await claimBitemporal(acct)
  await claimSemanticRespectsTime(acct2)
  await claimNoDoublePayout()
  await claimCrashRecovery()
  await claimEndToEnd()
  await claimDecisionRevalidated()
  await claimVectorIndexIsUsed()
  await claimRapidRevisions()
  await claimTrustEnforced()
  await claimMoneyAndMemoryCommitTogether()

  console.log(failures === 0 ? '\nAll claims verified.' : `\n${failures} FAILED`)
  await pool.end()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
