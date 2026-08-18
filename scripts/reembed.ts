import { pool } from '../lib/db'
import { embed, activeProvider } from '../lib/embeddings'

/**
 * Regenerate every embedding with the currently configured provider.
 *
 * Embeddings from different models occupy different vector spaces. Mixing them in one
 * index makes distances meaningless, a fact embedded locally and a query embedded by
 * Bedrock produce a number, and the number means nothing. Switching provider therefore
 * requires rewriting the column, not just changing an env var.
 *
 * Statements are unchanged, so this is safe to re-run and does not touch validity.
 */
async function main() {
  const provider = activeProvider()
  console.log(`Re-embedding with provider: ${provider}`)

  const rows = await pool.query<{ entity_id: string; key: string; version: number; statement: string }>(
    `SELECT entity_id, key, version, statement FROM facts ORDER BY recorded_at`)
  console.log(`${rows.rowCount} facts to process`)

  let done = 0
  for (const r of rows.rows) {
    const vector = await embed(r.statement)
    await pool.query(
      `UPDATE facts SET embedding = $4 WHERE entity_id = $1 AND key = $2 AND version = $3`,
      [r.entity_id, r.key, r.version, `[${vector.join(',')}]`])
    done++
    if (done % 25 === 0) console.log(`  ${done}/${rows.rowCount}`)
  }

  console.log(`Done. ${done} rows rewritten.`)
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
