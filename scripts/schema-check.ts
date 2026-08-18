import fs from 'node:fs'
import path from 'node:path'
import { pool } from '../lib/db'
import { EMBEDDING_DIM } from '../lib/embeddings'

/**
 * Schema drift detector.
 *
 * scripts/verify.ts proves the system behaves correctly. This proves the schema it is
 * behaving on is still the one lib/schema.sql declares.
 *
 * Both of the most expensive bugs in this project were schema bugs that looked like
 * success from every angle except a query plan:
 *
 *   1. The vector index was built with the default vector_l2_ops operator class while
 *      semanticRecall ranks by cosine <=>. Built, listed by SHOW INDEXES, never chosen.
 *   2. The vector index was full rather than partial, so it was not applicable under the
 *      `valid_to IS NULL` predicate every live recall carries. Same symptom.
 *
 * Neither is visible in the DDL an application ships; both are only visible in the DDL a
 * cluster actually holds. So this reads three sources and fails when they disagree: what
 * lib/schema.sql declares, what the TypeScript depends on, and what is deployed.
 *
 * Introspection goes through a single `exec` seam so the same checks can run over the
 * CockroachDB Cloud Managed MCP Server when a service-account token is present, and over
 * the PostgreSQL wire protocol when it is not. The active path is always named in the
 * output, because a drift report you cannot attribute to a source is not evidence.
 */

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `, ${detail}` : ''}`)
  if (!ok) failures++
}

/** Context lines that describe the run rather than judge it. Never affects the verdict. */
const note = (text: string) => console.log(`        ${text}`)

type Row = Record<string, unknown>

// ── the cluster, as two interchangeable inspection surfaces ──────────────────

type Inspector = {
  /** Human-readable provenance for the header line. */
  path: string
  exec: (sql: string) => Promise<Row[]>
  close: () => Promise<void>
}

const MCP_ENDPOINT = process.env.COCKROACH_MCP_URL ?? 'https://cockroachlabs.cloud/mcp'
const MCP_TOKEN = process.env.COCKROACH_MCP_TOKEN ?? process.env.CC_API_TOKEN
const MCP_PROTOCOL_VERSION = '2025-06-18'

/**
 * The managed server is one fixed endpoint for the whole organisation and selects the
 * cluster from an `mcp-cluster-id` header, which takes the cluster UUID from the Console
 * URL. That UUID appears nowhere in a connection string: DATABASE_URL carries the cluster
 * *name*. So the name is what can be derived here, and the id is either configured or
 * looked up through the server's own list_clusters tool.
 */
function target() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    return {
      host: url.host,
      // CockroachDB Cloud hostnames lead with the cluster name: tredecim-31962.j77.<region>...
      cluster: process.env.COCKROACH_MCP_CLUSTER ?? url.hostname.split('.')[0],
      database: url.pathname.replace(/^\//, '') || 'defaultdb',
    }
  } catch {
    return { host: 'unset DATABASE_URL', cluster: process.env.COCKROACH_MCP_CLUSTER ?? '', database: '' }
  }
}

function sqlInspector(): Inspector {
  return {
    path: `SQL over the PostgreSQL wire protocol (${target().host})`,
    exec: async (sql) => (await pool.query(sql)).rows as Row[],
    close: async () => { await pool.end() },
  }
}

// ── MCP client: JSON-RPC 2.0 over streamable HTTP ────────────────────────────

type McpTool = {
  name: string
  description?: string
  inputSchema?: { properties?: Record<string, unknown> }
}

type McpSession = { id: string | null; clusterId: string | null }

let rpcId = 0

function mcpHeaders(session: McpSession) {
  return {
    'content-type': 'application/json',
    // Streamable HTTP lets the server answer with either a JSON body or an SSE stream, and
    // the server is the one that chooses, so both have to be acceptable.
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${MCP_TOKEN}`,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    ...(session.clusterId ? { 'mcp-cluster-id': session.clusterId } : {}),
    ...(session.id ? { 'mcp-session-id': session.id } : {}),
  }
}

/** One JSON-RPC round trip. Mutates the session with the id the server hands back. */
async function rpc(session: McpSession, method: string, params?: unknown) {
  const id = ++rpcId
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: mcpHeaders(session),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    // The challenge distinguishes invalid_request (no token) from invalid_token (wrong or
    // expired one), which is the difference between a setup mistake and a rotated secret.
    const why = res.headers.get('www-authenticate') ?? (await res.text()).slice(0, 200)
    throw new Error(`${method}: HTTP ${res.status} ${why}`)
  }

  session.id ??= res.headers.get('mcp-session-id')

  const body = await res.text()
  const frames = res.headers.get('content-type')?.includes('text/event-stream')
    ? body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    : [body]

  for (const frame of frames) {
    if (!frame) continue
    const msg = JSON.parse(frame) as { id?: number; result?: unknown; error?: { message?: string } }
    if (msg.id !== id) continue
    if (msg.error) throw new Error(`${method}: ${msg.error.message ?? 'RPC error'}`)
    return msg.result
  }
  throw new Error(`${method}: no response frame matched request id ${id}`)
}

/**
 * The managed server deliberately exposes no general SQL tool. It offers select_query and
 * explain_query; show_statement exists only on the self-hosted build. So each statement is
 * routed to the tool permitted to run it, and a statement with no matching tool fails
 * loudly rather than being quietly skipped, which would turn an unchecked invariant into a
 * passing report.
 */
const TOOL_CANDIDATES = {
  explain: ['explain_query'],
  show: ['show_statement'],
  select: ['select_query'],
} as const

type Statement = keyof typeof TOOL_CANDIDATES

const kindOf = (sql: string): Statement =>
  /^\s*EXPLAIN\b/i.test(sql) ? 'explain' : /^\s*SHOW\b/i.test(sql) ? 'show' : 'select'

/**
 * Fill whichever argument names the tool's own schema advertises.
 *
 * The docs name the tools but not their parameters, so reading inputSchema is the only way
 * to be right about them without a token to experiment with.
 */
function toolArgs(tool: McpTool, sql: string): Record<string, unknown> {
  const props = Object.keys(tool.inputSchema?.properties ?? {})
  const pick = (...names: string[]) => names.find((n) => props.includes(n))

  const args: Record<string, unknown> = {}
  args[pick('sql', 'query', 'statement', 'sql_query', 'command') ?? 'sql'] = sql
  const databaseKey = pick('database', 'database_name', 'db')
  if (databaseKey) args[databaseKey] = target().database
  return args
}

/** Tool results arrive as content blocks; rows may be structured or JSON inside text. */
function rowsFrom(result: unknown): Row[] {
  const r = result as {
    structuredContent?: unknown
    content?: { type?: string; text?: string }[]
    isError?: boolean
  }
  if (r?.isError) throw new Error(`tool reported an error: ${JSON.stringify(r.content).slice(0, 200)}`)

  const candidates: unknown[] = []
  if (r?.structuredContent !== undefined) candidates.push(r.structuredContent)
  for (const block of r?.content ?? []) {
    if (block?.type === 'text' && block.text) {
      try { candidates.push(JSON.parse(block.text)) } catch { /* not a JSON payload */ }
    }
  }

  for (const c of candidates) {
    if (Array.isArray(c)) return c as Row[]
    const nested = (c as { rows?: unknown; results?: unknown; data?: unknown })
    for (const v of [nested?.rows, nested?.results, nested?.data]) {
      if (Array.isArray(v)) return v as Row[]
    }
  }
  throw new Error('could not read result rows from the tool response')
}

async function mcpInspector(): Promise<Inspector> {
  const session: McpSession = {
    id: null,
    clusterId: process.env.COCKROACH_MCP_CLUSTER_ID ?? null,
  }

  const init = await rpc(session, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'tredecim-schema-check', version: '0.1.0' },
  })
  const server = (init as { serverInfo?: { name?: string; version?: string } })?.serverInfo

  // A spec-compliant server rejects tools/call until the client acknowledges the handshake.
  await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: mcpHeaders(session),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(30_000),
  })

  const tools = ((await rpc(session, 'tools/list', {}) as { tools?: McpTool[] })?.tools ?? [])
  const offered = new Map(tools.map((t) => [t.name, t]))
  const toolFor = (kind: Statement) =>
    TOOL_CANDIDATES[kind].map((n) => offered.get(n)).find(Boolean)

  note(`MCP server: ${`${server?.name ?? 'unnamed'} ${server?.version ?? ''}`.trim()}`)
  note(`MCP tools offered: ${tools.map((t) => t.name).join(', ') || 'none'}`)

  // The cluster UUID is not derivable from DATABASE_URL, so when it is not configured the
  // server is asked to map the cluster name onto it.
  if (!session.clusterId && offered.has('list_clusters')) {
    const clusters = rowsFrom(await rpc(session, 'tools/call', { name: 'list_clusters', arguments: {} }))
    const match = clusters.find((c) => String(c.name) === target().cluster)
    session.clusterId = match ? String(match.id) : null
    note(`list_clusters resolved "${target().cluster}" to ${session.clusterId ?? 'no matching cluster'}`)
  }
  if (!session.clusterId) {
    throw new Error('no cluster id: set COCKROACH_MCP_CLUSTER_ID (the UUID in the Console URL)')
  }

  const selectTool = toolFor('select')
  if (!selectTool) {
    throw new Error(`no SELECT-capable tool among [${tools.map((t) => t.name).join(', ') || 'none'}]`)
  }
  note(`MCP tools used: ${(['select', 'explain', 'show'] as Statement[])
    .map((k) => `${k} -> ${toolFor(k)?.name ?? 'unavailable'}`).join(', ')}`)

  return {
    path: `CockroachDB Cloud Managed MCP Server (${MCP_ENDPOINT}, cluster ${session.clusterId})`,
    exec: async (sql) => {
      const kind = kindOf(sql)
      const tool = toolFor(kind)
      if (!tool) throw new Error(`the MCP server offers no tool that can run a ${kind.toUpperCase()} statement`)
      return rowsFrom(await rpc(session, 'tools/call', { name: tool.name, arguments: toolArgs(tool, sql) }))
    },
    close: async () => { await pool.end() },
  }
}

/**
 * Reachability probe, run only when no token is configured.
 *
 * This asks the endpoint whether it exists and what it wants; it reads no schema and is
 * reported as context, not as an integration. The alternative is to say nothing about MCP
 * at all, which leaves a reader unable to tell "not attempted" from "attempted and broken".
 */
async function probeMcpReachability() {
  try {
    const res = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'tredecim-schema-check', version: '0.1.0' } },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    note(`MCP endpoint ${MCP_ENDPOINT} answered HTTP ${res.status} unauthenticated`)
    const challenge = res.headers.get('www-authenticate')
    if (challenge) note(`MCP challenge: ${challenge}`)

    const meta = await fetch('https://cockroachlabs.cloud/.well-known/oauth-protected-resource/mcp', {
      signal: AbortSignal.timeout(15_000),
    })
    if (meta.ok) {
      const m = await meta.json() as { scopes_supported?: string[]; bearer_methods_supported?: string[] }
      note(`MCP advertises scopes [${(m.scopes_supported ?? []).join(', ')}] via ${(m.bearer_methods_supported ?? []).join(', ')} bearer token`)
    }
  } catch (e) {
    note(`MCP endpoint probe failed: ${(e as Error).message}`)
  }
}

// ── what the repository declares ─────────────────────────────────────────────

type DeclaredIndex = {
  name: string
  table: string
  unique: boolean
  vector: boolean
  opclass: string | null
  predicate: string | null
}

/** Parens and case carry no meaning here, but the planner cares about the predicate. */
const normalise = (p: string | null | undefined) =>
  p ? p.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase() : null

function readDeclared(source: string) {
  // The file explains itself at length, and the prose quotes the DDL it is explaining, so
  // comments have to go before anything is matched or the parser reads the commentary.
  const sql = source.replace(/^\s*--.*$/gm, '')

  const tables = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)]
    .map((m) => m[1])

  const indexes: DeclaredIndex[] = [...sql.matchAll(
    /CREATE\s+(UNIQUE\s+|VECTOR\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ON\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*(?:WHERE\s+([^;]+?))?\s*;/gi)].map((m) => ({
    name: m[2],
    table: m[3],
    unique: /UNIQUE/i.test(m[1] ?? ''),
    vector: /VECTOR/i.test(m[1] ?? ''),
    opclass: m[4].match(/\b(vector_\w+_ops)\b/i)?.[1] ?? null,
    predicate: normalise(m[5]),
  }))

  // Both the inline CONSTRAINT form and the idempotent ALTER TABLE form appear in the file.
  const checks = new Set(
    [...sql.matchAll(/CONSTRAINT\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+CHECK/gi)].map((m) => m[1]))

  const addedColumns = [...sql.matchAll(
    /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([A-Za-z0-9()]+)/gi)].map((m) => ({ table: m[1], column: m[2], type: m[3].toUpperCase() }))

  const embeddingDim = Number(sql.match(/embedding\s+VECTOR\((\d+)\)/i)?.[1] ?? NaN)

  return { tables, indexes, checks: [...checks], addedColumns, embeddingDim }
}

// ── what the cluster holds ───────────────────────────────────────────────────

type DeployedIndex = {
  table_name: string
  index_name: string
  is_unique: boolean
  is_partial: boolean
  def: string
}

/**
 * pg_get_indexdef is the only source here that renders all three of uniqueness, the
 * partial predicate and the operator class in one string. SHOW INDEXES renders none of
 * them, which is precisely why both historical bugs survived a reading of SHOW INDEXES.
 */
const INDEX_SQL = `
  SELECT c.relname AS table_name,
         ic.relname AS index_name,
         i.indisunique AS is_unique,
         (i.indpred IS NOT NULL) AS is_partial,
         pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'`

const predicateOf = (def: string) => normalise(def.match(/\sWHERE\s+(.+)$/i)?.[1] ?? null)
const accessMethodOf = (def: string) => def.match(/\sUSING\s+(\w+)\s*\(/i)?.[1]?.toLowerCase() ?? null
const opclassOf = (def: string) => def.match(/\b(vector_\w+_ops)\b/i)?.[1]?.toLowerCase() ?? null

async function main() {
  const declared = readDeclared(
    fs.readFileSync(path.join(process.cwd(), 'lib', 'schema.sql'), 'utf8'))

  console.log('TREDECIM schema drift check')

  console.log('\n[0] Inspection path')
  let db: Inspector
  if (MCP_TOKEN) {
    try {
      db = await mcpInspector()
    } catch (e) {
      // A token was supplied deliberately, so MCP failing is a real problem worth failing on
      // rather than papering over. The checks still run, so the report stays useful.
      check('managed MCP server reachable with the supplied token', false, (e as Error).message)
      note('falling back to the SQL path so the drift checks still run')
      db = sqlInspector()
    }
  } else {
    note('no COCKROACH_MCP_TOKEN or CC_API_TOKEN in the environment, so MCP was not used')
    await probeMcpReachability()
    db = sqlInspector()
  }
  note(`schema read via: ${db.path}`)

  const deployedIndexes = await db.exec(INDEX_SQL) as unknown as DeployedIndex[]
  const byName = new Map(deployedIndexes.map((i) => [i.index_name, i]))

  // ── 1 ──────────────────────────────────────────────────────────────────────
  // Everything lib/schema.sql declares has to be on the cluster. A migration that was
  // written but never applied is drift even when nothing has broken yet.
  console.log('\n[1] Every object declared in lib/schema.sql exists on the cluster')

  const tables = (await db.exec(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_catalog = current_database()`)).map((r) => String(r.table_name))

  const missingTables = declared.tables.filter((t) => !tables.includes(t))
  check('every declared table is deployed', missingTables.length === 0,
    missingTables.length ? `missing ${missingTables.join(', ')}` : `${declared.tables.length} tables`)

  for (const want of declared.indexes) {
    const got = byName.get(want.name)
    if (!got) {
      check(`${want.name} is deployed`, false, 'declared in lib/schema.sql, absent from the cluster')
      continue
    }
    const sameUnique = got.is_unique === want.unique
    const samePredicate = predicateOf(got.def) === want.predicate
    const sameOpclass = (opclassOf(got.def) ?? null) === (want.opclass?.toLowerCase() ?? null)
    check(`${want.name} matches its declaration`, sameUnique && samePredicate && sameOpclass,
      sameUnique && samePredicate && sameOpclass ? '' : [
        sameUnique ? '' : `unique declared ${want.unique}, deployed ${got.is_unique}`,
        samePredicate ? '' : `predicate declared ${want.predicate ?? 'none'}, deployed ${predicateOf(got.def) ?? 'none'}`,
        sameOpclass ? '' : `opclass declared ${want.opclass ?? 'default'}, deployed ${opclassOf(got.def) ?? 'default'}`,
      ].filter(Boolean).join('; '))
  }

  // ── 2 ──────────────────────────────────────────────────────────────────────
  // The invariant the whole memory model rests on. If this index loses its uniqueness or
  // its predicate, two open intervals become insertable and nothing else notices.
  console.log('\n[2] facts_one_open still enforces the invariant')

  const oneOpen = byName.get('facts_one_open')
  check('facts_one_open exists', !!oneOpen)
  check('it is UNIQUE', oneOpen?.is_unique === true,
    'without uniqueness an entity can hold two simultaneous truths')
  check('it is partial on WHERE valid_to IS NULL', predicateOf(oneOpen?.def ?? '') === 'valid_to is null',
    // A full unique index on (entity_id, key) would reject the second *revision* of a fact,
    // not the second open one, so the history could never be retained.
    `deployed predicate: ${predicateOf(oneOpen?.def ?? '') ?? 'none'}`)

  const constraints = await db.exec(`SELECT * FROM [SHOW CONSTRAINTS FROM facts]`)
  const unique = constraints.find(
    (c) => c.constraint_name === 'facts_one_open' && c.constraint_type === 'UNIQUE')
  check('SHOW CONSTRAINTS agrees it is a validated UNIQUE constraint',
    !!unique && unique.validated === true, String(unique?.details ?? 'absent'))

  // ── 3 ──────────────────────────────────────────────────────────────────────
  // The two silent failures, checked directly. Both indexes are built and both are listed
  // by SHOW INDEXES in the broken case, so only the operator class and the predicate
  // distinguish a working index from a decorative one.
  console.log('\n[3] facts_live_embedding_idx can actually serve semanticRecall')

  const vec = byName.get('facts_live_embedding_idx')
  check('facts_live_embedding_idx exists', !!vec)
  check('it is a VECTOR index', accessMethodOf(vec?.def ?? '') === 'cspann',
    `access method: ${accessMethodOf(vec?.def ?? '') ?? 'none'}`)
  check('it uses vector_cosine_ops', opclassOf(vec?.def ?? '') === 'vector_cosine_ops',
    opclassOf(vec?.def ?? '') === 'vector_cosine_ops' ? ''
      : 'semanticRecall ranks by <=>, which the default vector_l2_ops cannot serve')
  check('it is partial on WHERE valid_to IS NULL', predicateOf(vec?.def ?? '') === 'valid_to is null',
    predicateOf(vec?.def ?? '') === 'valid_to is null' ? ''
      : 'a full index is not applicable under the validity predicate every live recall carries')

  // SHOW CREATE TABLE is the cluster's own rendering rather than the pg_catalog
  // compatibility view, so agreement between the two rules out a shim reporting an index
  // that the CockroachDB optimiser models differently.
  const ddl = String((await db.exec(`SELECT create_statement FROM [SHOW CREATE TABLE facts]`))[0]?.create_statement ?? '')
  check('SHOW CREATE TABLE renders the same index',
    /VECTOR INDEX facts_live_embedding_idx \(embedding vector_cosine_ops\) WHERE valid_to IS NULL/.test(ddl),
    ddl.match(/VECTOR INDEX[^\n]*/)?.[0]?.trim() ?? 'no VECTOR INDEX in the DDL')

  // An index can also be made invisible to the optimiser without being dropped, which is a
  // third member of the same family: present, correct, and never used.
  const visibility = await db.exec(`SELECT DISTINCT index_name, visible FROM [SHOW INDEXES FROM facts]`)
  const hidden = visibility.filter((r) => r.visible === false).map((r) => String(r.index_name))
  check('no index on facts is hidden from the optimiser', hidden.length === 0,
    hidden.length ? `not visible: ${hidden.join(', ')}` : '')

  // ── 4 ──────────────────────────────────────────────────────────────────────
  console.log('\n[4] Constraints declared in lib/schema.sql are validated on the cluster')

  for (const name of declared.checks) {
    const got = constraints.find((c) => c.constraint_name === name && c.constraint_type === 'CHECK')
    check(`${name} CHECK exists and is validated`, !!got && got.validated === true,
      String(got?.details ?? 'absent from the cluster'))
  }

  // ── 5 ──────────────────────────────────────────────────────────────────────
  // The dimension is agreed in three places, and a mismatch in any pair is a write that
  // fails at runtime rather than at deploy time.
  console.log('\n[5] Column types match what the code depends on')

  const columns = await db.exec(
    `SELECT table_name, column_name, crdb_sql_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_catalog = current_database()`)
  const columnType = (table: string, column: string) =>
    columns.find((c) => c.table_name === table && c.column_name === column)?.crdb_sql_type as string | undefined

  const embedding = columnType('facts', 'embedding')
  check('facts.embedding is VECTOR(1024)', embedding === `VECTOR(${EMBEDDING_DIM})`,
    `deployed ${embedding ?? 'absent'}, EMBEDDING_DIM in lib/embeddings.ts is ${EMBEDDING_DIM}`)
  check('lib/schema.sql declares the same dimension', declared.embeddingDim === EMBEDDING_DIM,
    `schema.sql declares VECTOR(${declared.embeddingDim})`)

  // Added by ALTER TABLE after the cluster was first provisioned, so CREATE TABLE IF NOT
  // EXISTS is a no-op for it and a cluster that missed the migration looks fully built.
  check('tx_journal.entity_id exists', !!columnType('tx_journal', 'entity_id'),
    `deployed ${columnType('tx_journal', 'entity_id') ?? 'absent'}`)

  for (const added of declared.addedColumns) {
    const got = columnType(added.table, added.column)
    check(`${added.table}.${added.column} is deployed as ${added.type}`,
      got?.toUpperCase() === added.type, `deployed ${got ?? 'absent'}`)
  }

  // ── 6 ──────────────────────────────────────────────────────────────────────
  // The DDL can be perfect and the planner can still decline to use it. This is the only
  // check that observes the optimiser's actual decision rather than the catalog.
  console.log('\n[6] The live recall plan does not fall back to a full scan')

  // Inlined rather than bound because the same statement has to survive a trip through an
  // MCP tool that takes a SQL string and no parameters. The literal is generated here, so
  // there is no untrusted input in it.
  const probe = `[${Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 7) / 10).join(',')}]`
  const plan = (await db.exec(
    `EXPLAIN SELECT statement FROM facts
      WHERE valid_to IS NULL ORDER BY embedding <=> '${probe}'::VECTOR LIMIT 5`)).map((r) => Object.values(r).join(' ')).join('\n')

  check('no full scan in the plan', !/FULL SCAN/i.test(plan),
    /FULL SCAN/i.test(plan) ? 'check the operator class and the partial predicate' : '')
  // The plan names facts_pkey too, on the lookup join that fetches the rows the vector
  // search selected, so the presence of a primary-key scan is not itself a fallback.
  const servedByVectorIndex = /facts@facts_live_embedding_idx/.test(plan)
  check('the vector index serves the query', servedByVectorIndex,
    servedByVectorIndex ? '' : `indexes in the plan: ${
      [...new Set(plan.match(/facts@\w+/g) ?? [])].join(', ') || 'none'}`)
  check('and it is the partial index that serves it', /partial index/.test(plan))

  console.log(failures === 0 ? '\nNo schema drift.' : `\n${failures} FAILED`)
  await db.close()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
