import { NextResponse } from 'next/server'
import { handleEvent } from '@/lib/agent'
import { DEMO_ACCOUNT, reset, runScenario, type ScenarioId } from '@/lib/demo'
import { recallAt, recallAsKnownAt, recallNow } from '@/lib/memory'

export const dynamic = 'force-dynamic'

/**
 * Single write endpoint for the console: inject an event, run a scenario, rewind the
 * memory to an instant, or reset the demo.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    action: 'event' | 'scenario' | 'rewind' | 'reset'
    kind?: string
    payload?: Record<string, unknown>
    scenario?: ScenarioId
    at?: string
  }

  try {
    switch (body.action) {
      case 'event': {
        if (!body.kind) return NextResponse.json({ error: 'kind required' }, { status: 400 })
        const episode = await handleEvent(DEMO_ACCOUNT, body.kind, body.payload ?? {})
        return NextResponse.json({ ok: true, outcome: episode.outcome })
      }

      case 'scenario': {
        if (!body.scenario) return NextResponse.json({ error: 'scenario required' }, { status: 400 })
        const result = await runScenario(body.scenario)
        return NextResponse.json({ ok: true, result })
      }

      case 'rewind': {
        const at = body.at ? new Date(body.at) : new Date()
        if (Number.isNaN(at.getTime())) {
          return NextResponse.json({ error: 'invalid timestamp' }, { status: 400 })
        }
        // Both axes, side by side: what was true then, and what we knew then.
        const [wasTrue, wasKnown, current] = await Promise.all([
          recallAt(DEMO_ACCOUNT, at),
          recallAsKnownAt(DEMO_ACCOUNT, at),
          recallNow(DEMO_ACCOUNT),
        ])
        return NextResponse.json({ ok: true, at: at.toISOString(), wasTrue, wasKnown, current })
      }

      case 'reset': {
        await reset()
        return NextResponse.json({ ok: true })
      }

      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (err) {
    // Constraint violations are the interesting outcome here, not an internal error:
    // the console shows them as evidence that the database refused the write.
    const e = err as { code?: string; message?: string }
    return NextResponse.json(
      { error: e.message ?? 'failed', pgCode: e.code ?? null },
      { status: e.code === '23505' ? 409 : 500 },
    )
  }
}
