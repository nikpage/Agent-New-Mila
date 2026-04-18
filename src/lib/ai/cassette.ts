/**
 * AI Cassette — record/replay layer for runAITask().
 *
 * Enabled via env:
 *   AI_CASSETTE_MODE = "record" | "replay" | (unset = disabled)
 *   AI_CASSETTE_FILE = path to JSON file (default: .cassettes/default.json)
 *
 * Key = sha256(stage + "\n" + prompt). Collisions are vanishingly unlikely
 * for real prompts; if one happens in replay mode it fails loud.
 *
 * Record: miss → caller hits real AI, then records; hit → return cached.
 * Replay: miss → throw; hit → return cached. NEVER calls real AI.
 *
 * Zero-cost when disabled (mode check is a string compare on a module-level const).
 */

import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

type Mode = 'record' | 'replay' | 'off'

const MODE: Mode = (() => {
  const m = process.env.AI_CASSETTE_MODE?.toLowerCase()
  if (m === 'record' && process.env.NODE_ENV === 'production') {
    throw new Error(
      `[cassette] AI_CASSETTE_MODE=record is not allowed in production — ` +
      `refusing to record real API calls. Unset AI_CASSETTE_MODE or set it to 'replay'.`,
    )
  }
  if (m === 'record' || m === 'replay') return m
  return 'off'
})()

const FILE = process.env.AI_CASSETTE_FILE || '.cassettes/default.json'
const META_KEY = '__meta__'

let cache: Record<string, string> | null = null

function load(): Record<string, string> {
  if (cache) return cache
  if (existsSync(FILE)) {
    try {
      cache = JSON.parse(readFileSync(FILE, 'utf-8'))
      return cache!
    } catch (err) {
      throw new Error(`[cassette] failed to parse ${FILE}: ${err instanceof Error ? err.message : err}`)
    }
  }
  cache = {}
  return cache
}

function persist(): void {
  if (!cache) return
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf-8')
}

/**
 * Pin the wall clock for prompt builders so cassette keys stay stable.
 * Record: capture now, persist into cassette. Replay: restore from cassette.
 * Runs at module load so the env var is set before any prompt is built.
 */
;(function bootstrapFixedNow() {
  if (MODE === 'off') return

  if (MODE === 'replay') {
    const meta = load()[META_KEY]
    if (meta && !process.env.AI_CASSETTE_FIXED_NOW) {
      try {
        const parsed = JSON.parse(meta) as { fixedNow?: string }
        if (parsed.fixedNow) {
          process.env.AI_CASSETTE_FIXED_NOW = parsed.fixedNow
          console.log(`[cassette] replay pinned to ${parsed.fixedNow}`)
        }
      } catch { /* ignore malformed meta */ }
    }
    return
  }

  if (!process.env.AI_CASSETTE_FIXED_NOW) {
    process.env.AI_CASSETTE_FIXED_NOW = new Date().toISOString()
  }
  const store = load()
  store[META_KEY] = JSON.stringify({ fixedNow: process.env.AI_CASSETTE_FIXED_NOW })
  persist()
  console.log(`[cassette] record pinned to ${process.env.AI_CASSETTE_FIXED_NOW}`)
})()

function keyFor(stage: string, prompt: string): string {
  return createHash('sha256').update(`${stage}\n${prompt}`).digest('hex')
}

export function cassetteEnabled(): boolean {
  return MODE !== 'off'
}

export function cassetteMode(): Mode {
  return MODE
}

/** Look up (stage, prompt) in cassette. Returns cached response or undefined. */
export function cassetteLookup(stage: string, prompt: string): string | undefined {
  if (MODE === 'off') return undefined
  const key = keyFor(stage, prompt)
  const hit = load()[key]
  if (hit !== undefined) {
    console.log(`[cassette] HIT ${stage} (${key.slice(0, 8)})`)
    return hit
  }
  if (MODE === 'replay') {
    throw new Error(
      `[cassette] MISS in replay mode — ${stage} (${key.slice(0, 8)}). ` +
      `Re-record cassette or fix prompt drift. File: ${FILE}`,
    )
  }
  return undefined
}

/** Record a fresh response in record mode. No-op in other modes. */
export function cassetteRecord(stage: string, prompt: string, response: string): void {
  if (MODE !== 'record') return
  const key = keyFor(stage, prompt)
  const store = load()
  store[key] = response
  persist()
  console.log(`[cassette] WRITE ${stage} (${key.slice(0, 8)})`)
}
