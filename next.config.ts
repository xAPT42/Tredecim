import type { NextConfig } from 'next'

/**
 * Amplify exposes console-configured variables to the build container only, the SSR
 * runtime receives none of them, at either app or branch scope. Declaring the keys here
 * inlines them into the compiled output, which is what actually ships.
 *
 * Every key below is read exclusively from server-side modules (the memory layer and the
 * route handlers), so nothing should reach the browser. `scripts/check-bundle.ts` runs
 * after every build and fails it if any of these values is found in the client bundle,
 * so that "should" is enforced rather than assumed.
 */
export const RUNTIME_KEYS = [
  'DATABASE_URL',
  'COCKROACH_CA_PEM',
  'BEDROCK_REGION',
  'BEDROCK_ACCESS_KEY_ID',
  'BEDROCK_SECRET_ACCESS_KEY',
  'BEDROCK_EMBED_MODEL',
  'EMBEDDINGS',
] as const

const nextConfig: NextConfig = {
  env: Object.fromEntries(
    RUNTIME_KEYS.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
}

export default nextConfig
