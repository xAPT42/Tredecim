import type { Browser, Page } from 'playwright'

/**
 * A first-time visitor's journey through the deployed console, driven by a real browser.
 *
 * verify.ts proves the claims against the cluster. This proves the thing an evaluator
 * actually opens: that the page paints, the buttons do something, the lifeline shows a
 * revision, and nothing throws on the way. Exits non-zero if any step of that journey
 * breaks, so a bad deploy is caught here rather than in front of the panel.
 *
 *   npm run e2e                                  the deployed console
 *   BASE_URL=http://localhost:3000 npm run e2e   whatever you are running locally
 */

const BASE_URL = (process.env.BASE_URL ?? 'https://main.d221uow5c9qoz0.amplifyapp.com')
  .replace(/\/+$/, '')

// A scenario fans eight concurrent episodes at a remote cluster; the observed worst case
// is around eleven seconds, and a cold serverless function is charged on top of that.
const SCENARIO_MS = 120_000
const LOAD_MS = 60_000

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `, ${detail}` : ''}`)
  if (!ok) failures++
}

// Collected across every page the run opens, including the resized ones.
const pageErrors: string[] = []
const serverErrors: string[] = []

function watch(page: Page) {
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`)
  })
  return page
}

/** waitForFunction that reports instead of throwing: a stuck console is a finding. */
async function waitFor(page: Page, fn: () => boolean, timeout: number) {
  try {
    await page.waitForFunction(fn, undefined, { timeout })
    return true
  } catch {
    return false
  }
}

type Snapshot = {
  facts: number; open: number; closed: number; journal: number
  figures: string[]; answer: string
}

/** Everything the console reports on screen, in one round trip. */
const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => ({
    facts: document.querySelectorAll('table.reading tbody tr').length,
    open: document.querySelectorAll('.interval.open').length,
    closed: document.querySelectorAll('.interval.closed').length,
    journal: document.querySelectorAll('.journal-row').length,
    figures: Array.from(document.querySelectorAll('.figures > div'), (d) =>
      `${d.querySelector('.label')?.textContent?.trim() ?? '?'}=${
        d.querySelector('.figure-value')?.textContent?.trim() ?? ''}`),
    answer: document.querySelector('.answer-panel pre.answer')?.textContent ?? '',
  }))

function diff(a: Snapshot, b: Snapshot) {
  const moved: string[] = []
  const counted = (name: string, x: number, y: number) => {
    if (x !== y) moved.push(`${name} ${x}→${y}`)
  }
  counted('fact rows', a.facts, b.facts)
  counted('closed intervals', a.closed, b.closed)
  counted('open intervals', a.open, b.open)
  counted('journal rows', a.journal, b.journal)
  b.figures.forEach((f, i) => {
    if (a.figures[i] === f) return
    const [label, value] = f.split('=')
    moved.push(`${label} ${(a.figures[i] ?? '=?').split('=')[1]}→${value}`)
  })
  return moved
}

/**
 * The console clears the answer panel before every request and restores it after, so an
 * empty panel is the only starting point from which "an answer arrived" is unambiguous.
 */
async function dismissAnswer(page: Page) {
  const close = page.locator('.answer-close')
  if (await close.count()) {
    await close.first().click()
    await page.waitForSelector('.answer-panel', { state: 'detached', timeout: 10_000 })
  }
}

/**
 * True once the console is idle again with an answer on screen. The page re-enables its
 * buttons only after reloading state, so this also means the DOM is no longer stale 
 * which is why nothing here sleeps for a fixed interval.
 */
const settled = (page: Page, timeout = SCENARIO_MS) =>
  waitFor(page, () => {
    const busy = Array.from(document.querySelectorAll('button.action'))
      .some((b) => (b as HTMLButtonElement).disabled)
    const panel = document.querySelector('.answer-panel')
    const answered = !!panel && (panel.textContent ?? '').replace('×', '').trim().length > 0
    return !busy && answered
  }, timeout)

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 80) ?? ''

// ── 1 ────────────────────────────────────────────────────────────────────────
// What a visitor sees in the first second: the masthead, and a lifeline with bars on it.
async function stepConsoleLoads(page: Page) {
  console.log('\n[1] The console loads')

  const wordmark = (await page.locator('.wordmark').innerText().catch(() => '')).trim()
  const tagline = (await page.locator('.tagline').innerText().catch(() => '')).trim()
  check('the wordmark renders', wordmark === 'TREDECIM', wordmark || 'missing')
  check('the tagline renders', tagline === 'BITEMPORAL AGENT MEMORY', tagline || 'missing')

  const drawn = await waitFor(page, () => document.querySelectorAll('.interval').length > 0, LOAD_MS)
  check('the lifeline draws without any interaction', drawn,
    `${await page.locator('.interval').count()} intervals on first paint`)
}

// ── 2 ────────────────────────────────────────────────────────────────────────
// The console degrades to a page of zeros if the cluster is unreachable, and says so in
// the body rather than the status line. Read the app's own call, not a fresh one.
function stepStateEndpoint(status: number, body: Record<string, unknown>) {
  console.log('\n[2] The state endpoint is live')

  const facts = Array.isArray(body.facts) ? body.facts : []
  check('/api/state answers 200', status === 200,
    status === 200 ? '' : `${status} · ${String(body.error ?? '')} ${String(body.detail ?? '')}`.trim())
  check('it names the embedding provider in use',
    typeof body.provider === 'string' && body.provider.length > 0, String(body.provider))
  check('it carries at least one fact', facts.length >= 1, `${facts.length} facts`)
}

// ── 3 ────────────────────────────────────────────────────────────────────────
// Run first, so the scenarios below start from a known baseline rather than from whatever
// the last visitor left behind, and so the demo is left rich rather than empty.
async function stepReset(page: Page, index: number) {
  console.log('\n[3] Reset returns the demo to a clean baseline')

  await dismissAnswer(page)
  await page.locator('button.action').nth(index).click()
  const done = await settled(page)
  const after = await snapshot(page)

  const failed = /"error"/.test(after.answer)
  check('the reset completes', done)
  check('it reports no error', !failed, failed ? firstLine(after.answer) : '')
  check('the lifeline still has intervals to draw', after.open >= 1, `${after.open} in force`)
  check('and every one of them is in force again', after.closed === 0, `${after.closed} closed`)
}

// ── 4 ────────────────────────────────────────────────────────────────────────
// A button that looks like it worked and did nothing is the surprise this run exists to
// catch, so each click is measured against what the console reported before it.
async function stepScenarios(page: Page, scenarios: { label: string; index: number }[]) {
  console.log('\n[4] Every scenario button runs and moves the console')

  for (const { label, index } of scenarios) {
    await dismissAnswer(page)
    const before = await snapshot(page)
    const threwBefore = pageErrors.length
    const started = Date.now()

    await page.locator('button.action').nth(index).click()
    const done = await settled(page)
    const after = await snapshot(page)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)

    const threw = pageErrors.slice(threwBefore)
    const clean = threw.length === 0 && !/"error"\s*:/.test(after.answer)
    check(`"${label}" completes`, done, `${seconds}s`)
    check(`"${label}" raises no client-side error`, clean,
      clean ? '' : threw.join(' | ') || firstLine(after.answer))

    // Three of the four scenarios write; the fourth is a pair of vector reads and moves
    // nothing by design, so its evidence is the answer it puts on screen.
    const moved = diff(before, after)
    check(`"${label}" changes what the console reports`,
      moved.length > 0 || after.answer.trim().length > 20,
      moved.length
        ? moved.join(', ')
        : `answer panel only, ${after.answer.trim().length} chars, a read-only scenario`)
  }
}

// ── 5 ────────────────────────────────────────────────────────────────────────
// The one picture the whole project rests on: a closed interval and an open one, side by
// side, with the closed one still naming its successor.
async function stepLifeline(page: Page) {
  console.log('\n[5] The lifeline shows both sides of a revision')

  const s = await snapshot(page)
  const total = await page.locator('.interval').count()
  const superseded = await page.evaluate(() =>
    Array.from(document.querySelectorAll('table.reading tbody tr'))
      .filter((tr) => /closed .*→ v\d+/.test(tr.textContent ?? '')).length)

  check('intervals are drawn', total >= 1, `${total} intervals`)
  check('at least one is marked closed', s.closed >= 1, `${s.closed} closed`)
  check('at least one is in force', s.open >= 1, `${s.open} in force`)
  check('a closed row still names the version that replaced it', superseded >= 1,
    `${superseded} superseded rows`)
}

// ── 6 ────────────────────────────────────────────────────────────────────────
// The question the console is built to answer, asked the way a visitor would ask it.
async function stepTemporalQuery(page: Page) {
  console.log('\n[6] The temporal query answers on both axes')

  await dismissAnswer(page)
  // Parked at the far right the two axes agree, which demonstrates nothing. Drag the
  // playhead back into the history the scenarios just wrote.
  await page.locator('.scrubber').fill('45')

  await page.locator('.footer button').click()
  const done = await settled(page, LOAD_MS)
  const answer = await page.locator('.answer-panel').first().innerText().catch(() => '')

  check('the query returns an answer panel', done && answer.trim().length > 0,
    firstLine(answer))
  check('it reports what was true in the world', /true in the world/i.test(answer))
  check('it reports what was known to the agent', /known to the agent/i.test(answer))
  check('it reports what is in force now', /in force now/i.test(answer))
}

// ── 7 ────────────────────────────────────────────────────────────────────────
// Measured on a fresh load at each size rather than by resizing the driven page: the
// scrubber has been moved by now, and the playhead is one of the things that can overflow.
async function stepLayout(browser: Browser) {
  console.log('\n[7] The layout holds at both sizes')

  for (const [width, height] of [[1280, 800], [900, 700]]) {
    const page = watch(await browser.newPage({ viewport: { width, height } }))
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: LOAD_MS })
    // The playhead label is the last thing placed, so its presence means layout is final.
    await page.waitForSelector('.playhead-label', { timeout: LOAD_MS })

    const m = await page.evaluate(() => {
      const doc = document.documentElement
      const over = Array.from(document.querySelectorAll('body *'))
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)
        })
        .map((el) => {
          const cls = el.getAttribute('class')
          return el.tagName.toLowerCase() + (cls ? `.${cls.trim().split(/\s+/).join('.')}` : '')
        })
      return { client: doc.clientWidth, scroll: doc.scrollWidth, over: [...new Set(over)] }
    })
    const controls = await page.locator('button.action').count()

    check(`the body does not scroll horizontally at ${width}x${height}`,
      m.scroll <= m.client + 1,
      m.scroll <= m.client + 1
        ? ''
        : `${m.scroll}px of content in ${m.client}px · overflowing: ${m.over.slice(0, 4).join(', ') || 'unattributed'}`)
    check(`every control is still rendered at ${width}x${height}`, controls >= 5,
      `${controls} buttons`)

    await page.close()
  }
}

async function launch(): Promise<Browser> {
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    console.error('\nPlaywright is not installed.\nRun:  npm install\n')
    process.exit(1)
  }
  try {
    return await chromium.launch()
  } catch (e) {
    const message = (e as Error).message
    if (/Executable doesn't exist|playwright install/i.test(message)) {
      console.error('\nPlaywright has no Chromium to drive.\nRun:  npx playwright install chromium\n')
    } else {
      console.error(message)
    }
    process.exit(1)
  }
}

async function main() {
  console.log(`TREDECIM browser journey, ${BASE_URL}`)

  const browser = await launch()
  const page = watch(await browser.newPage({ viewport: { width: 1280, height: 800 } }))

  const firstState = page.waitForResponse((r) => r.url().includes('/api/state'), { timeout: LOAD_MS })
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: LOAD_MS })
  const state = await firstState
  const body = (await state.json().catch(() => ({}))) as Record<string, unknown>

  await stepConsoleLoads(page)
  stepStateEndpoint(state.status(), body)

  // Labels come off the page rather than out of this file, so renaming a scenario in the
  // console does not quietly reduce this run to testing four buttons that no longer exist.
  const reserved = new Set(['Reset demo', 'Ask the memory'])
  const titles = (await page.locator('button.action .action-title').allInnerTexts())
    .map((t) => t.trim())
  const scenarios = titles
    .map((label, index) => ({ label, index }))
    .filter((b) => !reserved.has(b.label))
  const resetIndex = titles.indexOf('Reset demo')

  console.log(`\n[·] Found: ${titles.join(' · ')}`)
  // A floor rather than an exact count: every scenario the console offers gets driven
  // below, so adding one extends this run instead of breaking it.
  check('the four scenarios and the reset are on offer', scenarios.length >= 4 && resetIndex >= 0,
    `${scenarios.length} scenarios, reset ${resetIndex >= 0 ? 'present' : 'missing'}`)

  if (resetIndex >= 0) await stepReset(page, resetIndex)
  await stepScenarios(page, scenarios)
  await stepLifeline(page)
  await stepTemporalQuery(page)
  await stepLayout(browser)

  console.log('\n[8] Nothing threw and nothing failed on the wire')
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('no 5xx responses', serverErrors.length === 0,
    [...new Set(serverErrors)].slice(0, 3).join(' | '))

  console.log(failures === 0 ? '\nThe journey holds.' : `\n${failures} FAILED`)
  await browser.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
