/**
 * TREDECIM benchmark, what the memory layer actually costs, against a live cluster.
 *
 *   npx tsx --env-file=.env.local scripts/bench.ts
 *
 * Four questions, in the order they are asked: how long does a revision take to commit,
 * how long does a point-in-time read take, what happens when several agents revise the same
 * fact in the same instant, and does semantic recall degrade as the memory grows.
 *
 * Every row written here lives under a dedicated entity namespace and is deleted at the
 * end, including when the run throws or is interrupted. The demo account is never touched.
 *
 * Expect ten to fifteen minutes from a laptop on another continent, a good half of which is
 * loading and then retiring the ten thousand vectors of the last section. BENCH_CORPUS
 * shortens it: BENCH_CORPUS=500,2000 keeps the shape of the curve at a quarter of the cost.
 */

const CONCURRENCY = [2, 4, 8, 16]

// Both of these have to be set before lib/db and lib/embeddings are first evaluated, which
// is why the imports below are dynamic. The pool reads its size once at module load: left
// at the serverless default of 4, the sixteen-writer round would queue on node-postgres and
// measure the client rather than the cluster. Bedrock would put a second network hop, and a
// token bill, inside every measurement.
process.env.PG_POOL_MAX = String(Math.max(...CONCURRENCY) + 8)
if (!process.env.EMBEDDINGS) process.env.EMBEDDINGS = 'local'

// Sections are individually runnable, because they are not equally cheap: re-checking the
// concurrency behaviour costs a minute, while the corpus section loads and then retires ten
// thousand vectors to say anything at all.
const ALL_SECTIONS = ['writes', 'reads', 'contention', 'semantic'] as const
type Section = (typeof ALL_SECTIONS)[number]
const SECTIONS = (process.env.BENCH_SECTIONS ?? ALL_SECTIONS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean) as Section[]
const runs = (s: Section) => SECTIONS.includes(s)

const WRITE_OPS = Number(process.env.BENCH_WRITES ?? 200)
const READ_OPS = Number(process.env.BENCH_READS ?? 200)
const SEMANTIC_QUERIES = Number(process.env.BENCH_SEMANTIC ?? 20)
const CORPUS_STAGES = (process.env.BENCH_CORPUS ?? '500,2000,5000,10000')
  .split(',')
  .map((n) => Number(n.trim()))

/**
 * Benchmark entities all sit inside one contiguous UUID range, so cleanup is a range
 * delete on the primary key and an interrupted run can be swept by the next one.
 */
const NS = 'beac0000-0000-4000-8000-'
const RANGE_FIRST = `${NS}000000000000`
const RANGE_LAST = `${NS}ffffffffffff`
const ENTITY = {
  write: `${NS}000000000001`,
  contend: `${NS}000000000002`,
  corpus: `${NS}000000000003`,
}

// Every key starts with this, so the tx_journal rows the memory layer writes under
// 'assert:<key>' can be swept by the same prefix.
const KEY = { write: 'benchiban', race: 'benchrace', corpus: 'benchcorpus' }

type DbModule = typeof import('../lib/db')
type MemoryModule = typeof import('../lib/memory')
let db!: DbModule
let memory!: MemoryModule

/** Vector indexes as the table actually declares them, read once at startup. */
let vectorIndexes: { name: string; definition: string }[] = []

// ── measurement helpers ──────────────────────────────────────────────────────
function pct(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

const ms = (n: number) => `${n.toFixed(0)} ms`

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now()
  const value = await fn()
  return [value, performance.now() - started]
}

/** "23514 x5, 40001 x2", distinct values with their counts. */
function tally(xs: string[], format: (x: string) => string = (x) => x): string {
  return [...new Set(xs)].map((x) => `${format(x)} x${xs.filter((y) => y === x).length}`).join(', ')
}

function mdTable(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}

// ── corpus generation ────────────────────────────────────────────────────────
const NOUNS = [
  'destination account', 'billing address', 'kyc tier', 'dispute reference',
  'payout schedule', 'risk score', 'account balance', 'preferred currency',
  'contact email', 'mandate reference', 'settlement window', 'chargeback ratio',
]
const VERBS = ['is', 'was set to', 'changed to', 'now reads', 'is recorded as']
const TAILS = [
  'after the last review', 'per the onboarding file', 'confirmed by the provider',
  'pending verification', 'as of the latest statement',
]

function corpusStatement(i: number): string {
  return `${NOUNS[i % NOUNS.length]} ${VERBS[(i >> 2) % VERBS.length]} ` +
    `FR${76 + (i % 20)} ${1000 + i} ${TAILS[(i >> 5) % TAILS.length]}`
}

const RECALL_QUERIES = [
  'where should the refund be sent',
  'is this customer verified',
  'what is the current balance on the account',
  'has a dispute been opened recently',
  'which currency does the customer prefer',
]

// ── results ──────────────────────────────────────────────────────────────────
type Percentiles = { n: number; p50: number; p95: number; p99: number }
type SemanticRow = {
  corpus: number
  shipped: Percentiles
  asOf: Percentiles
  control: number
  plans: { shipped: string; asOf: string; control: string }
  loadRowsPerSec: number | null
  ranges: number | null
}
type ContentionRow = {
  writers: number
  committed: number
  refused: number
  retries: number
  codes: string
  rawCodes: string[]
  wallMs: number
  openIntervals: number
}

const results: {
  writes?: Percentiles & { commitOnlyP50: number; retries: number }
  reads?: Percentiles & { rowsScanned: number }
  semantic: SemanticRow[]
  contention: ContentionRow[]
  env: Record<string, string>
  tableSizeAtStart: number
} = { semantic: [], contention: [], env: {}, tableSizeAtStart: 0 }

const RUN_STARTED = performance.now()

// ── 1 ────────────────────────────────────────────────────────────────────────
// A revision is a close and an open in one serializable transaction. This is the number
// an agent pays on every decision it commits to memory.
async function benchWrites() {
  console.log(`\n[1] Write latency, ${WRITE_OPS} fact revisions (close + open, one transaction)`)

  for (let i = 0; i < 5; i++) {
    await memory.assertFact(ENTITY.write, KEY.write, i, `warm up revision ${i}`)
  }

  const wall: number[] = []
  const commit: number[] = []
  let retries = 0

  for (let i = 0; i < WRITE_OPS; i++) {
    const [res, elapsed] = await timed(() =>
      memory.assertFact(ENTITY.write, KEY.write, `FR76${1000 + i}`,
        `Destination account is FR76 ${1000 + i}`))
    wall.push(elapsed)
    commit.push(res.latencyMs)
    retries += res.retries
    if ((i + 1) % 50 === 0) console.log(`      ${i + 1}/${WRITE_OPS}  p50 so far ${ms(pct(wall, 50))}`)
  }

  results.writes = {
    n: wall.length,
    p50: pct(wall, 50), p95: pct(wall, 95), p99: pct(wall, 99),
    commitOnlyP50: pct(commit, 50),
    retries,
  }
  console.log(`      p50 ${ms(pct(wall, 50))}  p95 ${ms(pct(wall, 95))}  p99 ${ms(pct(wall, 99))}  retries ${retries}`)
}

// ── 2 ────────────────────────────────────────────────────────────────────────
// Valid-time travel over the history the write benchmark just produced.
async function benchPointInTime() {
  console.log(`\n[2] Point-in-time read latency, ${READ_OPS} recallAt over that history`)

  const span = await db.pool.query<{ lo: Date; hi: Date; n: number }>(
    `SELECT min(valid_from) AS lo, max(valid_from) AS hi, count(*)::INT AS n
       FROM facts WHERE entity_id = $1`,
    [ENTITY.write])
  const { lo, hi, n } = span.rows[0]
  if (!n) {
    console.log('      skipped: no write history to read (run the writes section first)')
    return
  }
  const window = hi.getTime() - lo.getTime()

  for (let i = 0; i < 5; i++) await memory.recallAt(ENTITY.write, new Date())

  const lat: number[] = []
  for (let i = 0; i < READ_OPS; i++) {
    // Random instants across the whole history, so the measurement is not a single hot row.
    const at = new Date(lo.getTime() + Math.random() * window)
    const [, elapsed] = await timed(() => memory.recallAt(ENTITY.write, at))
    lat.push(elapsed)
  }

  results.reads = {
    n: lat.length,
    p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99),
    rowsScanned: n,
  }
  console.log(`      p50 ${ms(pct(lat, 50))}  p95 ${ms(pct(lat, 95))}  p99 ${ms(pct(lat, 99))}  over ${n} intervals`)
}

// ── 3 ────────────────────────────────────────────────────────────────────────
// N agents revise the same (entity, key) at the same instant. The partial unique index is
// the referee; what we want to know is what it costs and who is told no.
async function benchContention() {
  console.log('\n[3] Concurrent revisions of the same (entity, key)')

  for (const writers of CONCURRENCY) {
    const key = `${KEY.race}${writers}`
    await memory.assertFact(ENTITY.contend, key, 'seed', `Destination account is FR00 seed ${writers}`)

    // Server clock, not ours, so the journal window is not at the mercy of clock skew.
    const mark = (await db.pool.query<{ at: Date }>('SELECT now() AS at')).rows[0].at

    const started = performance.now()
    const settled = await Promise.allSettled(
      Array.from({ length: writers }, (_, i) =>
        memory.assertFact(ENTITY.contend, key, `w${i}`,
          `Destination account is FR76 writer ${i} of ${writers}`)))
    const wallMs = performance.now() - started

    const codes = settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => (s.reason as { code?: string }).code ?? 'unknown')
    const journal = await db.pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::INT AS n FROM tx_journal
        WHERE label = $1 AND at >= $2 GROUP BY status`,
      [`assert:${key}`, mark])
    const open = await db.pool.query<{ n: number }>(
      `SELECT count(*)::INT AS n FROM facts
        WHERE entity_id = $1 AND key = $2 AND valid_to IS NULL`,
      [ENTITY.contend, key])

    const row: ContentionRow = {
      writers,
      committed: settled.filter((s) => s.status === 'fulfilled').length,
      refused: codes.length,
      retries: journal.rows.find((r) => r.status === 'retry')?.n ?? 0,
      codes: codes.length ? tally(codes, (c) => `\`${c}\``) : ', ',
      rawCodes: codes,
      wallMs,
      openIntervals: open.rows[0].n,
    }
    results.contention.push(row)
    console.log(
      `      N=${String(writers).padStart(2)}  committed ${row.committed}  refused ${row.refused}` +
      `  retries ${row.retries}  wall ${ms(wallMs)}  open intervals ${row.openIntervals}`)
  }

  const refused = results.contention.reduce((n, c) => n + c.refused, 0)
  const attempted = results.contention.reduce((n, c) => n + c.writers, 0)
  if (refused) {
    console.log(
      `\n  WARNING: ${refused} of ${attempted} concurrent revisions were refused outright, not ` +
      `retried. Codes: ${tally(results.contention.flatMap((c) => c.rawCodes))}`)
  }
}

// ── 4 ────────────────────────────────────────────────────────────────────────
// Semantic recall as the memory grows. The corpus is loaded with plain INSERTs rather than
// assertFact: the write path is measured in section 1, and ten thousand serializable
// transactions across an ocean would take an hour to prove nothing new.
async function loadCorpus(from: number, to: number): Promise<number> {
  const { embed } = await import('../lib/embeddings')
  const BATCH = 100
  const started = performance.now()

  for (let base = from; base < to; base += BATCH) {
    const values: string[] = []
    const params: unknown[] = []
    for (let i = base; i < Math.min(base + BATCH, to); i++) {
      const statement = corpusStatement(i)
      const vector = await embed(statement)
      const p = params.length
      params.push(ENTITY.corpus, `${KEY.corpus}${i}`, statement, `[${vector.join(',')}]`)
      values.push(
        `($${p + 1},$${p + 2},1,to_jsonb($${p + 3}::STRING),$${p + 3},now(),NULL,'inferred',0.9,$${p + 4})`)
    }
    await db.pool.query(
      `INSERT INTO facts
         (entity_id,key,version,value,statement,valid_from,valid_to,source,confidence,embedding)
       VALUES ${values.join(',')}`,
      params)
  }

  const elapsed = (performance.now() - started) / 1000
  return (to - from) / elapsed
}

/**
 * What the planner actually chose.
 *
 * Read against the vector indexes the table really has rather than a name compiled in here:
 * a query that reaches one is a different animal from one that sorts the whole table, and
 * the difference is invisible in a latency figure taken on a small corpus. Note that a plan
 * naming the vector index also names facts_pkey, for the join that fetches the columns, so
 * the vector node has to be looked for first.
 */
async function planFor(sql: string, params: unknown[]): Promise<string> {
  const r = await db.pool.query<Record<string, string>>(`EXPLAIN ${sql}`, params)
  const plan = r.rows.map((row) => Object.values(row).join(' ')).join('\n')
  const used = vectorIndexes.find((v) => plan.includes(`facts@${v.name}`))
  if (used) return 'vector index'
  const table = plan.match(/table: facts@(\S+)/)
  return table ? `full scan of ${table[1]}` : 'unknown'
}

async function countOpenFacts(): Promise<number> {
  const r = await db.pool.query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM facts WHERE valid_to IS NULL`)
  return r.rows[0].n
}

async function rangeCount(): Promise<number | null> {
  try {
    const r = await db.pool.query<{ n: number }>(
      `SELECT count(*)::INT AS n FROM [SHOW RANGES FROM TABLE facts]`)
    return r.rows[0].n
  } catch {
    // Not every cluster tier exposes range metadata; the corpus figures stand without it.
    return null
  }
}

async function benchSemantic() {
  console.log('\n[4] Semantic recall vs corpus size')
  const { embed } = await import('../lib/embeddings')

  let loaded = 0
  for (const stage of CORPUS_STAGES) {
    const rowsPerSec = stage > loaded ? await loadCorpus(loaded, stage) : null
    loaded = Math.max(loaded, stage)

    const corpus = await countOpenFacts()
    const lat: number[] = []
    const asOfLat: number[] = []
    for (let i = 0; i < SEMANTIC_QUERIES; i++) {
      const query = RECALL_QUERIES[i % RECALL_QUERIES.length]
      const [, live] = await timed(() => memory.semanticRecall(query, { limit: 5 }))
      lat.push(live)
      // The same question over the same rows, differing only in the shape of the predicate:
      // a validity window instead of the open-interval test the partial index is built on.
      // Whatever separates these two columns is the cost of asking a historical question.
      const [, historical] = await timed(() =>
        memory.semanticRecall(query, { limit: 5, asOf: new Date() }))
      asOfLat.push(historical)
    }

    const vector = `[${(await embed(RECALL_QUERIES[0])).join(',')}]`
    const now = new Date()
    const shippedSql =
      `SELECT entity_id, embedding <=> $1 AS distance FROM facts
        WHERE valid_to IS NULL ORDER BY distance LIMIT 5`
    const asOfSql =
      `SELECT entity_id, embedding <=> $1 AS distance FROM facts
        WHERE valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)
        ORDER BY distance LIMIT 5`
    // Control: same predicate, wrong distance function. An index built for one metric
    // cannot serve the other, and this column is what that costs.
    const controlSql =
      `SELECT entity_id FROM facts WHERE valid_to IS NULL ORDER BY embedding <-> $1 LIMIT 5`
    const [, controlMs] = await timed(() => db.pool.query(controlSql, [vector]))

    results.semantic.push({
      corpus,
      shipped: { n: lat.length, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) },
      asOf: {
        n: asOfLat.length,
        p50: pct(asOfLat, 50), p95: pct(asOfLat, 95), p99: pct(asOfLat, 99),
      },
      control: controlMs,
      plans: {
        shipped: await planFor(shippedSql, [vector]),
        asOf: await planFor(asOfSql, [vector, now]),
        control: await planFor(controlSql, [vector]),
      },
      loadRowsPerSec: rowsPerSec,
      ranges: await rangeCount(),
    })

    console.log(
      `      corpus ${String(corpus).padStart(6)} open facts  live p50 ${ms(pct(lat, 50))}` +
      `  asOf p50 ${ms(pct(asOfLat, 50))}` +
      `  load ${rowsPerSec ? `${rowsPerSec.toFixed(0)} rows/s` : 'n/a'}`)
  }

  const scanned = results.semantic.filter((s) => s.plans.shipped !== 'vector index')
  if (scanned.length) {
    console.log(
      `\n  WARNING: the live recall path did not reach a vector index at ${scanned.length} of ` +
      `${results.semantic.length} corpus sizes: ${scanned.map((s) => `${s.corpus} facts ` +
      `(${s.plans.shipped})`).join(', ')}`)
  } else {
    console.log(`\n      every live query was served by ${vectorIndexes.map((v) => v.name).join(', ')}`)
  }
}

// ── environment ──────────────────────────────────────────────────────────────
async function describeEnvironment() {
  const { activeProvider } = await import('../lib/embeddings')

  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').hostname
    } catch {
      return 'unknown'
    }
  })()
  const region = host.match(/\.((?:aws|gcp|azure)-[a-z0-9-]+)\./)?.[1] ?? 'unknown'

  const version = await db.pool.query<{ v: string }>('SELECT version() AS v')

  // Baseline round-trip, measured after the pool is warm so TLS setup is not folded in.
  const rtt: number[] = []
  for (let i = 0; i < 20; i++) {
    const [, elapsed] = await timed(() => db.pool.query('SELECT 1'))
    rtt.push(elapsed)
  }

  const ddl = (await db.pool.query<{ create_statement: string }>('SHOW CREATE TABLE facts'))
    .rows[0].create_statement
  vectorIndexes = [...ddl.matchAll(/VECTOR INDEX (\w+) \(([^)]*)\)(?: WHERE ([^,\n]+))?/g)].map(
    (m) => ({ name: m[1], definition: `${m[2]}${m[3] ? ` WHERE ${m[3]}` : ''}` }))

  results.env = {
    'Embedding provider': activeProvider(),
    'Cluster region': region,
    'CockroachDB': version.rows[0].v.split(' ').slice(0, 3).join(' '),
    'Client': `node ${process.versions.node} on ${process.platform}/${process.arch}`,
    'Baseline round-trip (SELECT 1)': `p50 ${ms(pct(rtt, 50))}, p95 ${ms(pct(rtt, 95))}`,
    'Vector index': vectorIndexes.map((v) => `${v.name} (${v.definition})`).join('; ') || 'none',
    'Pool size': process.env.PG_POOL_MAX ?? '',
  }

  for (const [k, v] of Object.entries(results.env)) console.log(`  ${k}: ${v}`)
}

// ── report ───────────────────────────────────────────────────────────────────
function report() {
  const w = results.writes
  const r = results.reads
  const rtt = results.env['Baseline round-trip (SELECT 1)']
  const scanned = results.semantic.filter((s) => s.plans.shipped !== 'vector index')
  const refusedWrites = results.contention.reduce((n, c) => n + c.refused, 0)
  const attemptedWrites = results.contention.reduce((n, c) => n + c.writers, 0)
  results.env['Benchmark duration'] = `${((performance.now() - RUN_STARTED) / 1000).toFixed(0)} s`

  const out = [
    '## Benchmark',
    '',
    'Run `npm run bench`. Every figure is end-to-end from the client, so it carries a full',
    `round-trip to the cluster region (${results.env['Cluster region']}, baseline ${rtt}), a`,
    'benchmark run from compute in that region reports a fraction of these numbers, and the',
    `gap is the point. Embeddings come from the \`${results.env['Embedding provider']}\` provider,`,
    'in-process and deterministic, so no model call and no second network hop is hidden inside',
    'a measurement.',
    'The run writes under its own entity namespace and deletes it afterwards.',
    '',
    mdTable(['Environment', ''], Object.entries(results.env).map(([k, v]) => [k, `\`${v}\``])),
  ]

  if (w) out.push(
    '',
    '### Write latency, one fact revision (close + open, one serializable transaction)',
    '',
    mdTable(
      ['operations', 'p50', 'p95', 'p99', 'retries'],
      [[w.n, ms(w.p50), ms(w.p95), ms(w.p99), w.retries]]),
    '',
    `Five round-trips per revision, \`BEGIN\`, \`SELECT … FOR UPDATE\`, \`UPDATE\`, \`INSERT\`, \`COMMIT\`, `,
    `plus the \`tx_journal\` write the console reads. Commit-only p50 was ${ms(w.commitOnlyP50)}.`,
    `Measured against a table holding ${results.tableSizeAtStart} open facts.`)

  if (r) out.push(
    '',
    '### Point-in-time read, `recallAt`',
    '',
    mdTable(
      ['operations', 'intervals in history', 'p50', 'p95', 'p99'],
      [[r.n, r.rowsScanned, ms(r.p50), ms(r.p95), ms(r.p99)]]))

  if (results.semantic.length) out.push(
    '',
    '### Semantic recall vs corpus size',
    '',
    mdTable(
      ['open facts', 'p50', 'p95', 'p99', 'plan', 'bulk load', 'ranges'],
      results.semantic.map((s) => [
        s.corpus, ms(s.shipped.p50), ms(s.shipped.p95), ms(s.shipped.p99),
        s.plans.shipped,
        s.loadRowsPerSec ? `${s.loadRowsPerSec.toFixed(0)} rows/s` : ', ',
        s.ranges ?? ', ',
      ])),
    '',
    scanned.length
      ? `> **The live recall path did not reach a vector index at ${scanned.length} of ` +
        `${results.semantic.length} corpus sizes** (${scanned.map((s) => `${s.corpus} facts: ` +
        `${s.plans.shipped}`).join('; ')}). The p50 column above is a scan, not an index.`
      : `Every live query in that table was served by \`${vectorIndexes.map((v) => v.name).join('`, `')}\`. ` +
        'A flat curve across a growing corpus is the claim; a rising one would mean the planner had ' +
        'quietly stopped choosing the index.',
    '',
    'Bulk load is 100-row batches of 1024-dimension vectors pushed over the same long-haul',
    'link, so the absolute rate is bandwidth as much as index maintenance. The trend across',
    'rows is the part that answers the question: a rate that holds as the corpus grows tenfold',
    'is an index that is not falling behind its writes.',
    '',
    'The same query has two neighbours worth measuring. `asOf` recall asks for a validity',
    'window rather than the open-interval predicate the partial index is built on, and the',
    'control asks with `<->` rather than the `<=>` the index is built for. Both are the',
    'shipped query with one thing changed:',
    '',
    mdTable(
      ['open facts', '`asOf` p50', 'p95', 'plan', '`<->` control', 'plan'],
      results.semantic.map((s) => [
        s.corpus, ms(s.asOf.p50), ms(s.asOf.p95), s.plans.asOf, ms(s.control), s.plans.control,
      ])))

  if (results.contention.length) out.push(
    '',
    '### Concurrent revisions of the same (entity, key)',
    '',
    mdTable(
      ['writers', 'committed', 'refused', 'retries', 'refusal codes', 'wall clock', 'per writer', 'open intervals after'],
      results.contention.map((c) => [
        c.writers, c.committed, c.refused, c.retries, c.codes,
        ms(c.wallMs), ms(c.wallMs / c.writers), c.openIntervals,
      ])),
    '',
    '`assertFact` takes `SELECT … FOR UPDATE` on the open interval before closing it, so',
    'competing writers queue on the lock rather than collide; retries and refusals are counted',
    'from `tx_journal`, the same rows the console shows. Whatever the writers do to each other,',
    'the last column is the invariant: exactly one interval left open.',
    '',
    'A writer holds its connection for as long as it waits on that lock, so N concurrent',
    `revisions need N connections. The pool is sized at ${results.env['Pool size']} here for that reason: at the`,
    'serverless default of four, writers queue on node-postgres instead of on the database and',
    'the section measures the client.',
    ...(refusedWrites
      ? [
        '',
        `> **${refusedWrites} of ${attemptedWrites} concurrent revisions were refused outright**, and`,
        '> not with a retryable serialization failure. The codes are in the table; a `23514` is',
        '> the interval-ordering check refusing a `valid_to` that does not follow the',
        '> `valid_from` it is closing, and a `57014` or a connection timeout is the pool',
        '> starving rather than the database objecting. Either way the invariant holds and the',
        '> losing writes are lost rather than replayed.',
      ]
      : [
        '',
        `All ${attemptedWrites} concurrent revisions committed. Contention is paid in latency, in the`,
        'wall-clock column, rather than in refused or discarded writes.',
      ]))

  console.log(`\n${'─'.repeat(78)}\nMarkdown, ready to paste:\n${'─'.repeat(78)}\n`)
  console.log(out.join('\n'))
}

// ── lifecycle ────────────────────────────────────────────────────────────────
/**
 * Delete in small batches, and survive the connection dying.
 *
 * A single DELETE over ten thousand rows carrying 1024-dimension vectors makes for a
 * transaction large enough to be refused, and retiring a vector from the index costs about
 * what adding it did, so the teardown is long enough to outlive a session: a Basic cluster
 * has dropped the connection partway through. Leaving rows behind on the way out is the one
 * failure this script is not allowed to have, so each batch is retried rather than thrown.
 */
async function deleteInBatches(sql: string, params: unknown[], label: string): Promise<number> {
  let deleted = 0
  let failures = 0
  for (;;) {
    try {
      const r = await db.pool.query(sql, params)
      if (!r.rowCount) return deleted
      deleted += r.rowCount
      failures = 0
      if (deleted >= 1000) process.stdout.write(`\r  cleaning up… ${deleted} ${label} deleted`)
    } catch (e) {
      if (++failures > 10) throw e
      await new Promise((r) => setTimeout(r, 2000 * failures))
    }
  }
}

async function cleanup(): Promise<number> {
  const facts = await deleteInBatches(
    `DELETE FROM facts WHERE entity_id BETWEEN $1 AND $2 LIMIT 200`,
    [RANGE_FIRST, RANGE_LAST],
    'rows')
  if (facts >= 1000) process.stdout.write('\n')
  const journal = await deleteInBatches(
    `DELETE FROM tx_journal WHERE label LIKE 'assert:bench%' LIMIT 500`,
    [],
    'journal rows')
  return facts + journal
}

let shuttingDown = false
async function shutdown(code: number) {
  if (shuttingDown) return
  shuttingDown = true
  if (db) {
    try {
      console.log(`\nCleaning up… ${await cleanup()} rows removed.`)
    } catch (e) {
      console.error('Cleanup failed, benchmark rows may remain:', (e as Error).message)
      code = code || 1
    }
    await db.pool.end().catch(() => {})
  }
  process.exit(code)
}

async function main() {
  db = await import('../lib/db')
  memory = await import('../lib/memory')

  const { DEMO_ACCOUNT } = await import('../lib/demo')
  if (DEMO_ACCOUNT >= RANGE_FIRST && DEMO_ACCOUNT <= RANGE_LAST) {
    throw new Error('benchmark namespace overlaps the demo account, refusing to run')
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(130))
  }

  // Open every connection up front. Otherwise the first contention round pays for sixteen
  // TLS handshakes and reports them as contention.
  const clients = await Promise.all(
    Array.from({ length: Number(process.env.PG_POOL_MAX) }, () => db.pool.connect()))
  await Promise.all(clients.map((c) => c.query('SELECT 1')))
  clients.forEach((c) => c.release())

  console.log(`TREDECIM benchmark, sections: ${SECTIONS.join(', ')}`)
  await describeEnvironment()

  const orphans = await cleanup()
  if (orphans) console.log(`\n  swept ${orphans} rows left by an earlier run`)

  try {
    results.tableSizeAtStart = await countOpenFacts()
    if (runs('writes')) await benchWrites()
    if (runs('reads')) await benchPointInTime()
    if (runs('contention')) await benchContention()
    if (runs('semantic')) await benchSemantic()
    report()
  } catch (e) {
    console.error('\nBenchmark failed:', e)
    await shutdown(1)
  }
  await shutdown(0)
}

main().catch(async (e) => {
  console.error(e)
  await shutdown(1)
})
