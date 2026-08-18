import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import crypto from 'node:crypto'

export const EMBEDDING_DIM = 1024

/**
 * Embeddings sit behind an interface with two implementations.
 *
 * Bedrock is the real one. The deterministic local provider exists so the memory layer,
 * the agent loop and the whole test suite can run without cloud credentials, useful in
 * CI, and it keeps provisioning off the critical path during development. It is a hashed
 * bag-of-tokens projection: genuinely similar sentences land near each other, which is
 * all the tests need, but it is not a semantic model and is never used in production.
 */
export type EmbeddingProvider = 'bedrock' | 'local'

/**
 * Credentials.
 *
 * Some hosting environments reserve the `AWS_*` namespace for their own runtime, so the
 * same values have to arrive under different names. Both spellings are accepted, with the
 * unprefixed ones taking precedence when present; when neither is set the SDK falls back
 * to its normal chain (instance role, shared config, SSO).
 */
function credentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.BEDROCK_ACCESS_KEY_ID
  const secretAccessKey =
    process.env.AWS_SECRET_ACCESS_KEY ?? process.env.BEDROCK_SECRET_ACCESS_KEY
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined
}

function region() {
  return process.env.AWS_REGION ?? process.env.BEDROCK_REGION ?? 'us-east-1'
}

export function activeProvider(): EmbeddingProvider {
  if (process.env.EMBEDDINGS === 'local') return 'local'
  // An execution role supplies no key material, so the presence of a region is enough to
  // mean "a Bedrock endpoint is reachable" in a properly configured deployment.
  return credentials() || process.env.AWS_REGION || process.env.BEDROCK_REGION
    ? 'bedrock'
    : 'local'
}

let bedrock: BedrockRuntimeClient | null = null
function client() {
  bedrock ??= new BedrockRuntimeClient({ region: region(), credentials: credentials() })
  return bedrock
}

const cache = new Map<string, number[]>()

export async function embed(text: string): Promise<number[]> {
  const wanted = activeProvider()

  // Keyed by provider, not text alone. A single Bedrock failure falls back to the local
  // projection, and caching that under the bare text would keep serving a vector from the
  // wrong space long after Bedrock recovered, distances against it are numbers with no
  // meaning.
  const key = `${wanted}:${text}`
  const hit = cache.get(key)
  if (hit) return hit

  const { vector, provider } = wanted === 'bedrock' ? await bedrockEmbed(text) : { vector: localEmbed(text), provider: 'local' as const }

  // Memory statements repeat constantly across a run; caching keeps both latency and
  // token spend down. Bounded so a long-running process cannot grow without limit.
  if (cache.size > 2000) cache.clear()
  cache.set(`${provider}:${text}`, vector)
  return vector
}

async function bedrockEmbed(text: string): Promise<{ vector: number[]; provider: EmbeddingProvider }> {
  const modelId = process.env.BEDROCK_EMBED_MODEL ?? 'amazon.titan-embed-text-v2:0'
  try {
    const res = await client().send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIM, normalize: true }),
      }))
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding?: number[] }
    if (!parsed.embedding?.length) throw new Error('empty embedding in Bedrock response')
    return { vector: parsed.embedding, provider: 'bedrock' }
  } catch (err) {
    // A failed embedding must not lose a fact. The memory write is what matters; a
    // degraded vector only weakens semantic recall, and the row can be re-embedded.
    // The provider is reported honestly so the caller caches it in the right space.
    console.warn('[embeddings] Bedrock failed, falling back to local:', (err as Error).message)
    return { vector: localEmbed(text), provider: 'local' }
  }
}

/** Deterministic hashed projection. Same input always yields the same vector. */
function localEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

  for (const token of tokens) {
    // Three independent hash positions per token reduce collisions.
    for (let k = 0; k < 3; k++) {
      const h = crypto.createHash('sha256').update(`${k}:${token}`).digest()
      const idx = h.readUInt32BE(0) % EMBEDDING_DIM
      const sign = h[4] & 1 ? 1 : -1
      v[idx] += sign
    }
  }

  const norm = Math.hypot(...v)
  return norm === 0 ? v.map(() => 0) : v.map((x) => x / norm)
}
