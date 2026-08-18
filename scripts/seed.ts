import { pool } from '../lib/db'
import { reset, DEMO_ACCOUNT } from '../lib/demo'
import { lifeline } from '../lib/memory'

async function main() {
  await reset()
  const facts = await lifeline(DEMO_ACCOUNT)
  console.log(`Demo account ${DEMO_ACCOUNT} seeded with ${facts.length} facts:`)
  for (const f of facts) {
    console.log(`  ${f.key.padEnd(12)} v${f.version}  ${f.validTo ? 'closed' : 'in force'}  ${f.statement}`)
  }
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
