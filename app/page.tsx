'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Mark } from './mark'

type Fact = {
  entityId: string; key: string; version: number; value: unknown; statement: string
  validFrom: string; validTo: string | null; recordedAt: string
  source: string; confidence: number; supersededBy: number | null
}
type EventRow = { id: string; kind: string; payload: Record<string, unknown>; receivedAt: string; handledAt: string | null }
type JournalRow = { id: string; label: string; status: string; pgCode: string | null; latencyMs: number; at: string; repeats: number }

type State = {
  now: string
  provider: string
  facts: Fact[]
  events: EventRow[]
  journal: JournalRow[]
  account: { balanceCents: number; movedCents: number; payouts: number }
  metrics: { closedFacts: number; openFacts: number; refusedWrites: number; p50CommitMs: number | null }
}

const SCENARIOS = [
  { id: 'supersede',      title: 'Supersede a fact',         claim: 'Old interval closes, new one opens, one transaction. Nothing is deleted.' },
  { id: 'race',           title: 'Eight agents, one refund',  claim: 'Concurrent workers race the same payout. Exactly one gets through.' },
  { id: 'crash',          title: 'Kill a worker mid-flight',  claim: 'An episode dies between deciding and acting, then resumes from its checkpoint.' },
  { id: 'late-discovery', title: 'Learn something late',      claim: 'A fact true since before anyone noticed. The two clocks disagree.' },
  { id: 'stale-vector',   title: 'Stale-proof recall',        claim: 'A superseded fact still matches the query text, and is still unreachable.' },
  { id: 'async-window',   title: 'The extraction window',     claim: 'Deferred extraction debits the ledger and remembers nothing. One transaction agrees either way.' },
  { id: 'poison',         title: 'Poison the memory',         claim: 'An untrusted source asserts a new destination. Recorded, then refused at payout, reset to pay again.' },
] as const

/**
 * The guided tour exists because the console shows a lot at once, and a reader who does
 * not already know what bitemporal memory is has no way in. Each step runs one scenario
 * and says what just happened, in order, so understanding is led rather than assumed.
 */
const TOUR = [
  {
    scenario: 'supersede' as const,
    heading: 'A fact changes',
    body: 'The old interval closed and a new one opened, in one transaction. The old value is ruled through, not deleted.',
    focus: 'lifeline' as const,
  },
  {
    scenario: 'race' as const,
    heading: 'Eight agents, one refund',
    body: 'One got through. The rest were refused with 23505, by the database itself, not by a check somebody could delete later.',
    focus: 'journal' as const,
  },
  {
    scenario: 'crash' as const,
    heading: 'A worker dies holding the money',
    body: 'Killed between deciding and acting. Another resumed from the checkpoint, re-validated against live memory, and paid exactly once.',
    focus: 'figures' as const,
  },
  {
    scenario: 'late-discovery' as const,
    heading: 'The world moved before anyone noticed',
    body: 'A chargeback filed a moment ago, true for the last twelve minutes. Below: what was true then, and what the agent knew then.',
    focus: 'divergence' as const,
  },
] as const

type FocusZone = (typeof TOUR)[number]['focus']

/** Allen's thirteen relations, in the order he defined them. */
const RELATIONS = [
  'precedes', 'meets', 'overlaps', 'starts', 'during', 'finishes', 'equals',
  'preceded by', 'met by', 'overlapped by', 'started by', 'contains', 'finished by',
]

type Rewound = { at: string; wasTrue: Fact[]; wasKnown: Fact[]; current: Fact[] }

/** Consecutive identical events say the same thing repeatedly; one row with a count does not. */
function collapseEvents(rows: EventRow[]): (EventRow & { repeats: number })[] {
  const out: (EventRow & { repeats: number })[] = []
  for (const row of rows) {
    const last = out.at(-1)
    if (last && last.kind === row.kind && JSON.stringify(last.payload) === JSON.stringify(row.payload)) {
      last.repeats++
    } else {
      out.push({ ...row, repeats: 1 })
    }
  }
  return out
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export default function Console() {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [answer, setAnswer] = useState<string>('')
  const [scrub, setScrub] = useState(100)
  // -1 is the opening panel, 0..3 are the tour steps, null means the reader is on their own.
  const [tour, setTour] = useState<number | null>(-1)
  const [showRelations, setShowRelations] = useState(false)
  const [rewound, setRewound] = useState<Rewound | null>(null)

  const load = useCallback(async () => {
    const r = await fetch('/api/state', { cache: 'no-store' })
    if (r.ok) setState(await r.json())
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [load])

  // The lifeline spans the oldest fact to now, with a little headroom on each side.
  const window = useMemo(() => {
    if (!state?.facts.length) return null
    const stamps = state.facts.map((f) => new Date(f.validFrom).getTime())
    const end = new Date(state.now).getTime()
    const start = Math.min(...stamps)
    const pad = Math.max((end - start) * 0.04, 30_000)
    return { start: start - pad, end: end + pad }
  }, [state])

  const pct = useCallback(
    (t: number) => (window ? ((t - window.start) / (window.end - window.start)) * 100 : 0),
    [window])

  const playheadAt = useMemo(
    () => (window ? new Date(window.start + ((window.end - window.start) * scrub) / 100) : null),
    [window, scrub])

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key)
    setAnswer('')
    try {
      const r = await fetch('/api/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      setAnswer(JSON.stringify(data.result ?? data, null, 2))
      await load()
    } catch (e) {
      setAnswer(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function advanceTour() {
    if (tour == null) return
    // The opening panel explains before it demonstrates; each scenario runs on the way
    // into its step so the reader sees a change rather than reading about one.
    const next = tour === -1 ? 0 : tour + 1
    if (next >= TOUR.length) {
      setTour(null)
      return
    }
    setTour(next)
    setRewound(null)
    await post({ action: 'scenario', scenario: TOUR[next].scenario }, 'tour')

    // The last step is the only one whose point is invisible without moving the scrubber.
    // Asking the reader to find it themselves is how the demonstration gets missed: they
    // press the button with the playhead still at now, the two clocks agree, and the whole
    // argument reads as "nothing happened".
    if (TOUR[next].focus === 'divergence') await showDivergence()
  }

  /** Rewind far enough back that the backdated fact has not been recorded yet. */
  async function showDivergence() {
    if (!window) return
    const target = Date.now() - 9 * 60_000
    const at = Math.max(0, Math.min(100, ((target - window.start) / (window.end - window.start)) * 100))
    setScrub(at)
    await rewindTo(new Date(target))
  }

  async function rewindTo(at: Date) {
    setBusy('rewind')
    setAnswer('')
    try {
      const r = await fetch('/api/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rewind', at: at.toISOString() }),
      })
      setRewound(await r.json())
    } finally {
      setBusy(null)
    }
  }

  const rewind = () => (playheadAt ? rewindTo(playheadAt) : undefined)

  const rows = useMemo(() => {
    if (!state) return []
    const keys = [...new Set(state.facts.map((f) => f.key))].sort()
    return keys.map((key) => ({ key, intervals: state.facts.filter((f) => f.key === key) }))
  }, [state])

  const m = state?.metrics
  const euros = (c: number) => (c / 100).toFixed(2)

  // During the tour every zone except the one being discussed recedes. Guiding attention
  // is subtraction: an explanation added on top of a full screen only makes it fuller.
  const focus: FocusZone | null = tour != null && tour >= 0 ? TOUR[tour].focus : null
  const dim = (zone: string) => (focus && focus !== zone ? 'dimmed' : '')

  return (
    <>
      <header className="masthead">
        <Mark size={22} />
        <span className="wordmark">TREDECIM</span>
        <span className="tagline">BITEMPORAL AGENT MEMORY</span>
        <button className="link-quiet" onClick={() => setShowRelations((v) => !v)}>
          why thirteen?
        </button>
        {/* The drawing explains the transaction boundary the console can only show the
            consequences of, so it should be one click away rather than only in the repo. */}
        <a className="link-quiet" href="/architecture.svg" target="_blank" rel="noreferrer">
          architecture
        </a>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center' }}>
          {tour === null && (
            <button className="link-quiet" onClick={() => setTour(-1)}>restart the tour</button>
          )}
          <span className="badge">◆ SERIALIZABLE</span>
          <span className="label">
            {state ? `cockroachdb · embeddings ${state.provider}` : 'connecting…'}
          </span>
        </span>
      </header>

      {showRelations && (
        <div className="relations">
          <button className="answer-close" onClick={() => setShowRelations(false)} aria-label="dismiss">×</button>
          <p style={{ margin: '0 0 10px', maxWidth: '76ch', lineHeight: 1.6 }}>
            Between any two intervals of time there are exactly thirteen possible relations.
            James F. Allen proved it in 1983, and the set is complete: every temporal
            arrangement of two facts is one of these. The mark above is the first of them.
          </p>
          <div className="relation-grid">
            {RELATIONS.map((r, i) => (
              <span key={r} className="relation">
                <span className="relation-n">{String(i + 1).padStart(2, '0')}</span> {r}
              </span>
            ))}
          </div>
        </div>
      )}

      {busy && busy !== 'rewind' && (
        <div className="working" role="status">
          <span className="working-bar" />
          <span className="label">
            {busy === 'tour' ? 'running the scenario' : `running ${busy}`}, writing to the cluster
          </span>
        </div>
      )}

      <div className="grid">
        {/* ── events ────────────────────────────────────────────────── */}
        <section className={`col ${dim('events')}`}>
          <div className="label" style={{ marginBottom: 11 }}>Event stream</div>

          {!state?.events.length && <div className="entry-note">No events yet.</div>}

          {collapseEvents(state?.events ?? []).map((e) => {
            const accent = e.kind === 'iban.changed' ? 'accent-closed' : ''
            return (
              <div key={e.id} className={`entry ${accent}`}>
                <div className="entry-time">{clock(e.receivedAt)}</div>
                <div className="entry-title">
                  {e.kind}
                  {e.repeats > 1 && <span className="repeat" style={{ marginLeft: 6 }}>×{e.repeats}</span>}
                </div>
                {'amountCents' in e.payload && (
                  <div className="entry-note">{euros(Number(e.payload.amountCents))} EUR</div>
                )}
                {'iban' in e.payload && <div className="entry-note">{String(e.payload.iban)}</div>}
              </div>
            )
          })}

          <div className="label" style={{ margin: '18px 0 9px' }}>Inject</div>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              className="action"
              disabled={busy !== null}
              onClick={() => post({ action: 'scenario', scenario: s.id }, s.id)}
            >
              <div className="action-title">{busy === s.id ? 'running…' : s.title}</div>
              <div className="action-claim">{s.claim}</div>
            </button>
          ))}
          <button
            className="action"
            disabled={busy !== null}
            onClick={() => post({ action: 'reset' }, 'reset')}
          >
            <div className="action-title">{busy === 'reset' ? 'resetting…' : 'Reset demo'}</div>
            <div className="action-claim">Clear this account and rebuild its opening history.</div>
          </button>
        </section>

        {/* ── the lifeline ──────────────────────────────────────────── */}
        <section className="col">
          {tour === -1 && (
            <div className="welcome welcome-enter">
              <div className="label">Start here</div>
              <h1>An agent that knows <em>when</em> it knew.</h1>
              <p>
                A language model has no memory. Everything an agent appears to remember is
                something the surrounding system chose to put back in the prompt. So the
                question is never <em>can it recall this</em>, it is <strong>which version
                of the truth does it recall, and how does it know that version is still good.</strong>
              </p>
              <p>
                Most agent memory answers with vector similarity, which works until a fact
                changes. The old fact still matches the query, nothing marks it dead, and
                the agent retrieves a superseded truth with full confidence. In a chatbot
                that is an annoyance. Here it is a payment to a bank account the customer
                closed last week.
              </p>
              <p>
                Tredecim keeps every fact with the interval over which it is true, and
                never deletes anything. What follows is four things going wrong, and the
                database refusing each one.
              </p>
              <button className="cta" onClick={advanceTour} disabled={busy !== null}>
                {busy === 'tour' ? 'running…' : 'Show me →'}
              </button>
              <button className="link-quiet" style={{ marginLeft: 14 }} onClick={() => setTour(null)}>
                skip, I will explore
              </button>
            </div>
          )}

          {tour !== null && tour >= 0 && (
            <div className="tour">
              <div className="tour-progress">
                {TOUR.map((_, i) => (
                  <span key={i} className={`pip ${i <= tour ? 'on' : ''}`} />
                ))}
                <span className="label" style={{ marginLeft: 8 }}>
                  step {tour + 1} of {TOUR.length}
                </span>
              </div>
              <h2>{TOUR[tour].heading}</h2>
              <p>{TOUR[tour].body}</p>
              <button className="cta" onClick={advanceTour} disabled={busy !== null}>
                {busy === 'tour'
                  ? 'running…'
                  : tour === TOUR.length - 1
                    ? 'Done, let me explore'
                    : 'Next →'}
              </button>
              <button className="link-quiet" style={{ marginLeft: 14 }} onClick={() => setTour(null)}>
                stop the tour
              </button>
            </div>
          )}

          <div className={`figures ${dim('figures')}`}>
            <div>
              <div className="figure-value">
                {euros(state?.account.movedCents ?? 0)}<span className="figure-unit"> EUR</span>
              </div>
              <div className="label" style={{ marginTop: 3 }}>Moved</div>
            </div>
            <div>
              <div className="figure-value" style={{ color: 'var(--closed)' }}>
                {m?.refusedWrites ?? 0}
              </div>
              <div className="label" style={{ marginTop: 3 }}>Writes refused</div>
            </div>
            <div>
              <div className="figure-value">
                {m?.p50CommitMs == null ? ', ' : m.p50CommitMs.toFixed(0)}
                {m?.p50CommitMs != null && <span className="figure-unit">ms</span>}
              </div>
              <div className="label" style={{ marginTop: 3 }}>p50 commit</div>
            </div>
            <div>
              <div className="figure-value">{m?.closedFacts ?? 0}</div>
              <div className="label" style={{ marginTop: 3 }}>Facts closed</div>
            </div>
            <div>
              <div className="figure-value">{m?.openFacts ?? 0}</div>
              <div className="label" style={{ marginTop: 3 }}>In force</div>
            </div>
          </div>

          <div className="label" style={{ margin: '15px 0 9px' }}>
            Lifeline · demo account 88
          </div>

          <div className={`lifeline-frame ${dim('lifeline')}`}>
            {/* Keys live in their own gutter so a short interval never truncates its name. */}
            <div className="gutter" style={{ paddingTop: 12 }}>
              {rows.map((row) => (
                <div key={row.key} className="gutter-key">{row.key}</div>
              ))}
            </div>

            <div className="lifeline" style={{ minHeight: Math.max(rows.length * 28 + 24, 148) }}>
              {rows.flatMap((row, ri) =>
                row.intervals.map((f) => {
                  const from = new Date(f.validFrom).getTime()
                  const to = f.validTo ? new Date(f.validTo).getTime() : window?.end ?? from
                  const left = pct(from)
                  const width = Math.max(pct(to) - left, 2)
                  const raw = JSON.stringify(f.value)
                  // Several versions of one key share a row, so a long value ran straight
                  // through its neighbours' labels. Truncating keeps every interval
                  // readable; the full statement is on the tooltip.
                  const short = raw.length > 26 ? `${raw.slice(0, 25)}…` : raw
                  const value = `${short}${f.validTo ? '' : ' → ∞'}`
                  // A bar narrower than its text would clip it; put the value alongside
                  // instead, on whichever side has room.
                  const inside = width > 22
                  const next = row.intervals.find(
                    (o) => new Date(o.validFrom).getTime() > from)
                  const gap = next ? pct(new Date(next.validFrom).getTime()) - (left + width) : 100
                  const tip = `${f.statement}\nv${f.version} · ${f.source} · recorded ${clock(f.recordedAt)}`
                  return (
                    <div key={`${f.key}-${f.version}`}>
                      <div
                        className={`interval ${f.validTo ? 'closed' : 'open'}`}
                        style={{ left: `${left}%`, width: `${width}%`, top: ri * 28 + 6 }}
                        title={tip}
                      >
                        {inside && value}
                      </div>
                      {!inside && gap > 12 && (
                        <div
                          className={`interval-aside ${f.validTo ? 'closed' : 'open'}`}
                          style={
                            left + width > 62
                              ? { right: `${100 - left}%`, top: ri * 28 + 6, textAlign: 'right' }
                              : { left: `${left + width}%`, top: ri * 28 + 6 }
                          }
                          title={tip}
                        >
                          {value}
                        </div>
                      )}
                    </div>
                  )
                }))}

              {playheadAt && (
                <>
                  <div className="playhead" style={{ left: `${scrub}%` }} />
                  <div
                    className="playhead-label"
                    style={
                      scrub > 88
                        ? { right: 0, transform: 'none' }
                        : scrub < 12
                          ? { left: 0, transform: 'none' }
                          : { left: `${scrub}%` }
                    }
                  >
                    {clock(playheadAt.toISOString())}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="legend">
            <span><span className="swatch" style={{ background: 'var(--closed)' }} />closed, retained</span>
            <span><span className="swatch" style={{ background: 'var(--open)' }} />in force</span>
            {window && (
              <span style={{ marginLeft: 'auto' }}>
                {clock(new Date(window.start).toISOString())} ─── {clock(new Date(window.end).toISOString())}
              </span>
            )}
          </div>

          {rewound && (
            <div className={focus && focus !== 'divergence' ? 'dimmed' : ''}>
              <Divergence data={rewound} onClose={() => setRewound(null)} />
            </div>
          )}

          {answer && (
            <div className="answer-panel">
              <button className="answer-close" onClick={() => setAnswer('')} aria-label="dismiss">×</button>
              <pre className="answer" style={{ marginTop: 0 }}>{answer}</pre>
            </div>
          )}

          <>
              <div className={dim('table')}>
              <div className="label" style={{ margin: '22px 0 9px' }}>Memory, as it stands</div>
              <table className="reading">
                <thead>
                  <tr>
                    <th>key</th><th>value</th><th>v</th><th>since</th><th>provenance</th><th>state</th>
                  </tr>
                </thead>
                <tbody>
                  {state?.facts.map((f) => (
                    <tr key={`${f.key}-${f.version}`} className={f.validTo ? 'is-closed' : ''}>
                      <td>{f.key}</td>
                      <td>{JSON.stringify(f.value)}</td>
                      <td>{f.version}</td>
                      <td>{clock(f.validFrom)}</td>
                      <td>{f.source}</td>
                      <td style={{ color: f.validTo ? 'var(--closed)' : 'var(--open)' }}>
                        {f.validTo ? `closed ${clock(f.validTo)} → v${f.supersededBy}` : 'in force'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="footnote">
                A closed row is never deleted. It stays queryable, which is what makes
                “what did the agent believe when it moved the money” an answerable question
                rather than an archaeology project.
              </p>
              </div>
          </>
        </section>

        {/* ── journal ───────────────────────────────────────────────── */}
        <section className={`col ${dim('journal')}`}>
          <div className="label" style={{ marginBottom: 11 }}>Transaction journal</div>

          {!state?.journal.length && <div className="entry-note">Nothing yet.</div>}

          {state?.journal.map((j) => (
            <div key={j.id} className={`journal-row ${j.status}`}>
              <span style={{ color: j.status === 'commit' ? 'var(--open)' : 'var(--closed)' }}>
                {j.status === 'commit' ? '✓' : j.status === 'retry' ? '↻' : '✗'}
              </span>
              <span>{j.label}</span>
              {j.repeats > 1 && <span className="repeat">×{j.repeats}</span>}
              <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
                {j.pgCode ? j.pgCode : `${j.latencyMs.toFixed(0)}ms`}
              </span>
            </div>
          ))}

          {(state?.metrics.refusedWrites ?? 0) > 0 && (
            <p className="footnote" style={{ fontSize: 10.5, marginTop: 10 }}>
              23505 is the database refusing a second open interval. Those refusals are the
              invariant holding, not the system failing.
            </p>
          )}

          <div className="label" style={{ margin: '18px 0 8px', paddingTop: 13, borderTop: '1px solid var(--rule)' }}>
            The revision, in SQL
          </div>
          <pre className="answer" style={{ marginTop: 0 }}>
{`UPDATE facts
   SET valid_to = now(),
       superseded_by = $v
 WHERE entity_id = $e
   AND key = $k
   AND valid_to IS NULL;

INSERT INTO facts (…, valid_to)
VALUES (…, NULL);

-- both, or neither`}
          </pre>
        </section>
      </div>

      {/* ── temporal query ──────────────────────────────────────────── */}
      <footer className="footer">
        <span style={{ color: 'var(--closed)' }} className="mono">▸</span>
        <span className="mono" style={{ fontSize: 12 }}>
          what did you know at{' '}
          <span style={{ background: 'var(--open-wash)', padding: '1px 6px', borderRadius: 2 }}>
            {playheadAt ? clock(playheadAt.toISOString()) : ', '}
          </span>
          ?
        </span>
        <input
          className="scrubber"
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={scrub}
          onChange={(e) => setScrub(Number(e.target.value))}
        />
        <button className="action" style={{ width: 'auto', margin: 0 }} disabled={busy !== null} onClick={rewind}>
          <span className="action-title">{busy === 'rewind' ? 'reading…' : 'Ask the memory'}</span>
        </button>
      </footer>
    </>
  )
}

/**
 * The two temporal axes, side by side.
 *
 * Rendering them as three prose blocks made the point invisible: when the answers agree,
 * three identical lists read as repetition rather than as agreement. Here each key is one
 * row, and the cells that disagree are the ones that carry colour, so a divergence is
 * the thing the eye lands on, and its absence is legible too.
 */
function Divergence({ data, onClose }: { data: Rewound; onClose: () => void }) {
  const keys = [...new Set([...data.wasTrue, ...data.wasKnown, ...data.current].map((f) => f.key))].sort()
  const pick = (rows: Fact[], key: string) => rows.find((f) => f.key === key)
  const show = (f?: Fact) => (f ? `${JSON.stringify(f.value)} (v${f.version})` : ', ')

  const divergent = keys.filter((k) => show(pick(data.wasTrue, k)) !== show(pick(data.wasKnown, k)))

  return (
    <div className="answer-panel">
      <button className="answer-close" onClick={onClose} aria-label="dismiss">×</button>
      <div className="divergence">
        <div className="label" style={{ marginBottom: 10 }}>
          the memory at {clock(data.at)}
        </div>

        <table className="reading">
          <thead>
            <tr>
              <th></th>
              <th>true in the world</th>
              <th>known to the agent</th>
              <th>in force now</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const t = show(pick(data.wasTrue, k))
              const kn = show(pick(data.wasKnown, k))
              const differs = t !== kn
              return (
                <tr key={k} className={differs ? 'diverges' : ''}>
                  <td style={{ color: 'var(--muted)' }}>{k}</td>
                  <td style={differs ? { color: 'var(--closed)', fontWeight: 600 } : undefined}>{t}</td>
                  <td style={differs ? { color: 'var(--open)', fontWeight: 600 } : undefined}>{kn}</td>
                  <td style={{ color: 'var(--muted)' }}>{show(pick(data.current, k))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        <p className="footnote">
          {divergent.length === 0 ? (
            <>
              The two clocks agree at this instant, everything true had already been
              recorded. Run <em>Learn something late</em> and rewind to about ten minutes
              ago to pull them apart.
            </>
          ) : (
            <>
              {divergent.length === 1 ? 'One fact was' : `${divergent.length} facts were`} already
              true in the world at this instant, and the agent did not yet know it. That gap is
              why both axes are stored: an audit asks what the agent believed when it acted,
              not what happened to be true.
            </>
          )}
        </p>
      </div>
    </div>
  )
}
