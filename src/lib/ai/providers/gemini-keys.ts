/**
 * Gemini API Key Rotation — Single System-Wide Round-Robin
 *
 * Every Gemini call in Mila (chat, embedding, anything) goes through
 * getNextClient(). One counter, one key pool, strict round-robin.
 * No key is ever used twice in a row, even across different callers
 * or concurrent users.
 */

import { GoogleGenerativeAI } from '@google/generative-ai'

let clients: GoogleGenerativeAI[] = []
let rawKeys: string[] = []
let callIndex = Math.floor(Math.random() * 1000)

export function keyFingerprint(key: string): string {
  const prefix = 'AIza'
  const idx = key.indexOf(prefix)
  if (idx >= 0) return key.slice(idx + prefix.length, idx + prefix.length + 5) + '...'
  return key.slice(0, 5) + '...'
}

function initClients(): void {
  if (clients.length > 0) return

  const multiKeys = process.env.GEMINI_API_KEYS
  const keys = multiKeys
    ? multiKeys.split(',').map(k => k.replace(/\s/g, '')).filter(Boolean)
    : []

  if (keys.length === 0) {
    const singleKey = process.env.GEMINI_API_KEY
    if (!singleKey) throw new Error('GEMINI_API_KEY or GEMINI_API_KEYS not configured')
    const splitSingle = singleKey.split(',').map(k => k.replace(/\s/g, '')).filter(Boolean)
    keys.push(...splitSingle)
  }

  rawKeys = keys
  clients = keys.map(key => new GoogleGenerativeAI(key))
  console.log(`[Gemini] Initialized ${clients.length} API key(s)`)
}

export interface GeminiKeySelection {
  client: GoogleGenerativeAI
  keyIndex: number
  keyLabel: string
  fingerprint: string
}

/**
 * Get the next Gemini client in round-robin order.
 * Called by both chat provider and embedding generator.
 */
export function getNextClient(): GeminiKeySelection {
  initClients()
  const idx = callIndex % clients.length
  callIndex++
  return {
    client: clients[idx],
    keyIndex: idx,
    keyLabel: `Gemini-${idx + 1}`,
    fingerprint: keyFingerprint(rawKeys[idx]),
  }
}
