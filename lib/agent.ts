import type { PoolClient } from 'pg'
import { pool, tx } from './db'
import { assertFact, recallNow, semanticRecall, type Fact, type Source } from './memory'

export type Step = 'recall' | 'decide' | 'act' | 'done'

/**
 * Provenance floor for moving money.
 *
 * A destination account reaches this memory one of two ways: from a bank-side tool call
 * that checked it (`tool_verified`), or from somebody saying so, a caller on the phone,
 * a line in a chat transcript, a model's own inference. Only the first is evidence, so the
 * source test is the load-bearing half and it is absolute: no confidence value promotes a
 * `user_asserted` account number into a payable one.
 *
 * The floor then applies *within* the trusted source, because `tool_verified` does not mean
 * certain. A fuzzy match against a bank record, an OCR read of a mandate, a provider that
 * answers "probably", all legitimately land below 1.0. This sits just under the 1.0 a
 * clean verification writes, so a tool that hedges at all stops the payout and asks for a
 * human instead of guessing with someone else's money.
 *
 * It is one constant rather than a literal at each call site so that weakening the policy
 * is a visible edit to a named thing, not a digit changed somewhere in a condition.
 */
export const PAYOUT_CONFIDENCE_FLOOR = 0.95

export type Episode = {
  id: string
  eventId: string
  entityId: string
  goal: string
  status: 'running' | 'done' | 'failed'
  step: Step
  scratch: Record<string, unknown>
  outcome: unknown
}

const SELECT_EPISODE = `
  id, event_id AS "eventId", entity_id AS "entityId", goal, status, step, scratch, outcome
`

/**
 * The agent holds no state in memory between steps.
 *
 * Every transition is checkpointed to CockroachDB before the next one begins, so the
 * process can be killed at any point and another worker picks the episode up mid-flight.
 * This is the concrete answer to ephemeral in-process agent state: there is nothing to
 * lose, because there was never anything in the process to begin with.
 */
export async function runEpisode(episodeId: string): Promise<Episode> {
  for (;;) {
    const ep = await loadEpisode(episodeId)
    if (!ep || ep.status !== 'running') return ep!

    switch (ep.step) {
      case 'recall': {
        const facts = await recallNow(ep.entityId)
        const related = await semanticRecall(ep.goal, { entityId: ep.entityId, limit: 3 })
        await checkpoint(episodeId, 'decide', {
          ...ep.scratch,
          recalled: facts.map(summarise),
          related: related.map(summarise),
        })
        break
      }

      case 'decide': {
        const decision = decide(ep)
        await checkpoint(episodeId, 'act', { ...ep.scratch, decision })
        break
      }

      case 'act': {
        await act(ep)
        // `act` finalises the episode inside its own transaction.
        return (await loadEpisode(episodeId))!
      }

      default:
        return ep
    }
  }
}

/**
 * Policy. Deliberately rule-based rather than model-driven.
 *
 * What is being demonstrated is that the memory layer keeps the agent correct; routing
 * money through a sampled token stream would only add noise to that claim.
 *
 * The decision this produces is a *proposal*, not an authorisation. It is computed from
 * facts read during the recall step, and an episode can sit checkpointed between deciding
 * and acting for an unbounded time, that is the whole point of durable execution. `act`
 * re-validates against the live memory before any money moves.
 */
function decide(ep: Episode): Record<string, unknown> {
  const recalled = (ep.scratch.recalled ?? []) as ReturnType<typeof summarise>[]
  const byKey = new Map(recalled.map((f) => [f.key, f]))
  const event = (ep.scratch.event ?? {}) as { kind?: string; payload?: Record<string, unknown> }

  switch (event.kind) {
    case 'refund.requested': {
      const iban = byKey.get('iban')
      const frozen = byKey.get('account_frozen')
      const amount = Number(event.payload?.amountCents ?? 0)

      if (!iban) return { action: 'reject', reason: 'no destination on record' }
      if (frozen?.value === true) return { action: 'reject', reason: 'account frozen' }

      return {
        action: 'refund',
        amountCents: amount,
        // Recorded together so `act` can tell whether the world moved underneath it.
        destination: iban.value,
        destinationVersion: iban.version,
      }
    }

    case 'iban.changed':
      return {
        action: 'revise',
        key: 'iban',
        value: event.payload?.iban,
        statement: `Destination account is ${event.payload?.iban}`,
      }

    case 'account.frozen':
      return {
        action: 'revise',
        key: 'account_frozen',
        value: true,
        statement: 'Account is frozen and cannot receive payouts',
      }

    case 'dispute.opened':
      return {
        action: 'revise',
        key: 'dispute',
        value: { status: 'open', ref: event.payload?.ref },
        statement: `Dispute ${event.payload?.ref} is open on this account`,
      }

    default:
      return { action: 'noop', reason: `unhandled event kind: ${event.kind}` }
  }
}

async function act(ep: Episode) {
  const decision = (ep.scratch.decision ?? {}) as Record<string, unknown>

  switch (decision.action) {
    case 'refund': {
      const amount = Number(decision.amountCents ?? 0)
      const idempotencyKey = `refund:${ep.eventId}`

      // The payout and the memory of having paid out commit together. If the ledger
      // write is rejected, because another agent already paid this request, the memory
      // revision is rolled back with it. The agent cannot come to believe it refunded
      // something it did not.
      try {
        await assertFact(
          ep.entityId,
          'last_refund',
          { amountCents: amount, eventId: ep.eventId },
          `Refund of ${(amount / 100).toFixed(2)} EUR issued to ${decision.destination}`,
          {
            episodeId: ep.id,
            source: 'tool_verified',
            alongside: async (c: PoolClient) => {
              await assertStillValid(c, ep, decision)
              await c.query(
                `INSERT INTO ledger (account_id, amount_cents, kind, idempotency_key, episode_id)
                 VALUES ($1, $2, 'refund', $3, $4)`,
                [ep.entityId, -amount, idempotencyKey, ep.id])
              await c.query(
                `UPDATE accounts SET balance_cents = balance_cents - $2 WHERE id = $1`,
                [ep.entityId, amount])
            },
          })
      } catch (err) {
        if (err instanceof UntrustedDestination) {
          // Nothing was written: the trust check ran inside the same transaction as the
          // ledger insert, so the refusal and the rollback are the same event. The episode
          // ends here rather than re-deciding, and carries the provenance that stopped it
          // so the console and the operator see why, not just that.
          await finish(ep.id, {
            paid: false,
            refused: 'untrusted_destination',
            reason: err.reason,
            destination: err.fact.value,
            destinationVersion: err.fact.version,
            source: err.fact.source,
            confidence: err.fact.confidence,
            amountCents: amount,
          })
          return
        }
        if (err instanceof StaleDecision) {
          // The memory moved between deciding and acting. Nothing was written, send the
          // episode back to recall so it decides again against what is true now.
          await pool.query(
            `UPDATE episodes SET step = 'recall', updated_at = now() WHERE id = $1`,
            [ep.id])
          await runEpisode(ep.id)
          return
        }
        throw err
      }

      await finish(ep.id, { paid: true, amountCents: amount, destination: decision.destination })
      return
    }

    case 'revise': {
      await assertFact(
        ep.entityId,
        String(decision.key),
        decision.value,
        String(decision.statement),
        { episodeId: ep.id, source: 'tool_verified' })
      await finish(ep.id, { revised: decision.key })
      return
    }

    default:
      await finish(ep.id, { skipped: true, reason: decision.reason ?? 'noop' })
  }
}

/** Raised when the memory changed between deciding and acting. Not an error condition. */
class StaleDecision extends Error {
  constructor(readonly reason: string) {
    super(`decision no longer valid: ${reason}`)
  }
}

/**
 * Raised when the destination on record is not trustworthy enough to be paid.
 *
 * Deliberately not a subclass of StaleDecision, because the two want opposite handling.
 * A stale decision is repaired by deciding again against current memory, so the episode
 * goes back to recall. An untrusted destination is not repaired by looking again, the
 * second decision would read the same untrusted fact and arrive here once more, which is
 * a loop, not a retry. This one ends the episode, refused, with the provenance that
 * refused it recorded in the outcome.
 */
class UntrustedDestination extends Error {
  constructor(
    readonly reason: string,
    readonly fact: { value: unknown; version: number; source: Source; confidence: number }) {
    super(`refusing to move money: ${reason}`)
  }
}

/**
 * Re-check the assumptions the decision was built on, inside the transaction that is
 * about to move money, holding a lock on the row.
 *
 * Without this, `decide` and `act` are separated by a durable checkpoint of unbounded
 * duration: a customer who changes their bank details in that window would be paid at
 * the account they just replaced. Reading the fact again is not enough, it has to be
 * read under FOR UPDATE in the same transaction as the ledger write, so that a
 * concurrent revision either waits for this payout or forces it to abort.
 *
 * Provenance is checked in the same breath, and for the same reason. A decision made
 * against a tool-verified account is worth nothing if an untrusted revision lands while
 * the episode sits parked, the fact the money would actually go to is the live one, so
 * the live one is what has to be trusted. Checking trust in `decide` would read a fact
 * that no longer exists by the time the ledger is written.
 */
async function assertStillValid(c: PoolClient, ep: Episode, decision: Record<string, unknown>) {
  const r = await c.query<{
    key: string; value: unknown; version: number; source: Source; confidence: number
  }>(
    `SELECT key, value, version::INT AS version, source, confidence FROM facts
      WHERE entity_id = $1 AND key IN ('iban', 'account_frozen') AND valid_to IS NULL
      FOR UPDATE`,
    [ep.entityId])
  const live = new Map(r.rows.map((f) => [f.key, f]))

  const iban = live.get('iban')
  if (!iban) throw new StaleDecision('destination no longer on record')

  // Trust before identity, on purpose. If an untrusted revision both changed the
  // destination and lowered its provenance, the honest reason to report is the provenance:
  // it is the one that does not go away by deciding again. Reporting "the destination
  // changed" would send the episode back to recall to re-derive the same refusal.
  //
  // Note that the test runs in one direction only. Trust is required to *move* money, not
  // to withhold it, an unverified claim that an account is frozen still stops the payout
  // below, because the failure modes are not symmetric.
  if (iban.source !== 'tool_verified' || iban.confidence < PAYOUT_CONFIDENCE_FLOOR) {
    throw new UntrustedDestination(
      `destination v${iban.version} is ${iban.source} at confidence ${iban.confidence}; ` +
        `payouts require tool_verified at ${PAYOUT_CONFIDENCE_FLOOR} or above`,
      iban)
  }

  if (iban.value !== decision.destination) {
    throw new StaleDecision(
      `destination changed from ${JSON.stringify(decision.destination)} to ${JSON.stringify(iban.value)}`)
  }
  if (iban.version !== decision.destinationVersion) {
    throw new StaleDecision(`destination revised to v${iban.version}`)
  }
  if (live.get('account_frozen')?.value === true) {
    throw new StaleDecision('account was frozen after the decision')
  }
}

// ---------------------------------------------------------------- episode plumbing

export async function startEpisode(eventId: string, entityId: string, goal: string, event: unknown) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO episodes (event_id, entity_id, goal, scratch)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [eventId, entityId, goal, JSON.stringify({ event })])
  return r.rows[0].id
}

async function loadEpisode(id: string): Promise<Episode | null> {
  const r = await pool.query<Episode>(`SELECT ${SELECT_EPISODE} FROM episodes WHERE id = $1`, [id])
  return r.rows[0] ?? null
}

/** Durable state transition. Nothing advances until this commits. */
async function checkpoint(id: string, step: Step, scratch: Record<string, unknown>) {
  await pool.query(
    `UPDATE episodes SET step = $2, scratch = $3, updated_at = now() WHERE id = $1`,
    [id, step, JSON.stringify(scratch)])
}

async function finish(id: string, outcome: unknown) {
  await pool.query(
    `UPDATE episodes
        SET status = 'done', step = 'done', outcome = $2,
            finished_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(outcome)])
}

/**
 * Recovery sweep. Any episode still marked running has been orphaned by a dead worker;
 * re-running it is safe because every side effect is either idempotent or transactional.
 */
export async function resumeOrphaned(olderThanSeconds = 0): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM episodes
      WHERE status = 'running' AND updated_at < now() - $1::INTERVAL
      ORDER BY updated_at`,
    [`${olderThanSeconds} seconds`])

  const resumed: string[] = []
  for (const { id } of r.rows) {
    try {
      await runEpisode(id)
      resumed.push(id)
    } catch (err) {
      await pool.query(
        `UPDATE episodes SET status = 'failed', outcome = $2, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify({ error: (err as Error).message })])
    }
  }
  return resumed
}

/** Convenience: ingest an event and drive it to completion. */
export async function handleEvent(entityId: string, kind: string, payload: Record<string, unknown>) {
  const ev = await pool.query<{ id: string }>(
    `INSERT INTO events (entity_id, kind, payload) VALUES ($1, $2, $3) RETURNING id`,
    [entityId, kind, JSON.stringify(payload)])
  const eventId = ev.rows[0].id
  const goal = goalFor(kind, payload)
  const episodeId = await startEpisode(eventId, entityId, goal, { kind, payload })
  const episode = await runEpisode(episodeId)
  await pool.query(`UPDATE events SET handled_at = now() WHERE id = $1`, [eventId])
  return episode
}

function goalFor(kind: string, payload: Record<string, unknown>) {
  switch (kind) {
    case 'refund.requested':
      return `Refund ${(Number(payload.amountCents ?? 0) / 100).toFixed(2)} EUR to the account on record`
    case 'iban.changed':
      return 'Record the new destination account'
    case 'account.frozen':
      return 'Record that the account is frozen'
    case 'dispute.opened':
      return `Record dispute ${payload.ref}`
    default:
      return kind
  }
}

function summarise(f: Fact) {
  return {
    key: f.key,
    value: f.value,
    version: f.version,
    statement: f.statement,
    validFrom: f.validFrom,
    source: f.source,
  }
}
