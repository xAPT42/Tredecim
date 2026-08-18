import fs from 'node:fs'
import path from 'node:path'
import { RUNTIME_KEYS } from '../next.config'

/**
 * Fails the build if a server-only secret reached the client bundle.
 *
 * next.config.ts inlines runtime configuration so it survives into the SSR output, which
 * is safe only for as long as those values are referenced from server modules alone. One
 * stray import from a client component would quietly publish a database password to every
 * visitor. This turns that invariant into something the build enforces.
 */

const CLIENT_DIRS = ['.next/static', '.next/server/app'].map((d) => path.join(process.cwd(), d))

/** Short or low-entropy values produce false positives; those are not secrets anyway. */
const SECRET_KEYS = RUNTIME_KEYS.filter(
  (k) => k !== 'EMBEDDINGS' && k !== 'BEDROCK_EMBED_MODEL' && k !== 'BEDROCK_REGION',
)

function* files(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* files(full)
    else if (/\.(js|mjs|cjs|json|txt|map|html)$/.test(entry.name)) yield full
  }
}

const secrets = SECRET_KEYS.map((k) => [k, process.env[k]] as const).filter(
  ([, v]) => typeof v === 'string' && v.length >= 12,
)

if (secrets.length === 0) {
  console.log('check-bundle: no secrets configured in this environment, nothing to verify')
  process.exit(0)
}

// Only .next/static is genuinely browser-served. The server app directory is checked too
// because a "use client" component compiled there is shipped verbatim to the browser.
const leaks: string[] = []
for (const dir of CLIENT_DIRS) {
  for (const file of files(dir)) {
    const content = fs.readFileSync(file, 'utf8')
    for (const [key, value] of secrets) {
      if (content.includes(value!)) leaks.push(`${key} found in ${path.relative(process.cwd(), file)}`)
    }
  }
}

if (leaks.length) {
  console.error('\ncheck-bundle: server-only values reached client-visible output\n')
  for (const l of leaks) console.error(`  ${l}`)
  console.error('\nA value inlined by next.config.ts is referenced from a client module.')
  console.error('Move that read behind a route handler or a server component.\n')
  process.exit(1)
}

console.log(`check-bundle: ${secrets.length} secret(s) verified absent from client output`)
