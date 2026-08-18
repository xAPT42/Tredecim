import fs from 'node:fs'
import path from 'node:path'
import { pool } from '../lib/db'

/**
 * Applies schema.sql statement by statement.
 *
 * CockroachDB rejects DDL and DML mixed in one implicit transaction, and CREATE VECTOR
 * INDEX cannot run inside an explicit one, so each statement is sent on its own.
 */
async function main() {
  const sql = fs.readFileSync(path.join(process.cwd(), 'lib', 'schema.sql'), 'utf8')

  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)

  let applied = 0
  for (const statement of statements) {
    const label = statement.slice(0, 68).replace(/\s+/g, ' ')
    try {
      await pool.query(statement)
      console.log(`  ok   ${label}`)
      applied++
    } catch (err) {
      console.error(`  FAIL ${label}\n       ${(err as Error).message}`)
      throw err
    }
  }

  console.log(`\n${applied} statements applied.`)
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
