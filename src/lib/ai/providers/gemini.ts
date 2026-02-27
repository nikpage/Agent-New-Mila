/**
 * Gemini AI Provider
 * Wraps @google/generative-ai SDK behind the AIProvider interface.
 *
 * Supports multiple API keys via GEMINI_API_KEYS (comma-separated).
 * Falls back to single GEMINI_API_KEY if GEMINI_API_KEYS is not set.
 * Round-robins across keys to spread rate-limit budget.
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai'
import type { AIProvider, AIGenerateOptions } from './types'

let clients: GoogleGenerativeAI[] = []
let callIndex = Math.floor(Math.random() * 1000)
const modelCaches = new Map<number, Map<string, GenerativeModel>>()
const keyUsage = new Map<string, number>()

function initClients(): GoogleGenerativeAI[] {
  if (clients.length > 0) return clients

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

  clients = keys.map(key => new GoogleGenerativeAI(key))
  console.log(`[Gemini] Initialized ${clients.length} API key(s)`)
  return clients
}

function getModel(modelName: string): { model: GenerativeModel; keyLabel: string } {
  const allClients = initClients()
  const idx = callIndex % allClients.length
  callIndex++

  if (!modelCaches.has(idx)) {
    modelCaches.set(idx, new Map())
  }
  const cache = modelCaches.get(idx)!
  if (!cache.has(modelName)) {
    cache.set(modelName, allClients[idx].getGenerativeModel({ model: modelName }))
  }
  return { model: cache.get(modelName)!, keyLabel: `Gemini-${idx + 1}` }
}

export const geminiProvider: AIProvider = {
  async generateContent(model: string, prompt: string, options?: AIGenerateOptions): Promise<string> {
    const { model: m, keyLabel } = getModel(model)
    const result = await m.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: options?.temperature !== undefined ? { temperature: options.temperature } : undefined,
    })
    keyUsage.set(keyLabel, (keyUsage.get(keyLabel) || 0) + 1)
    return result.response.text()
  },
}

/** Get key usage counts and reset. Call at end of worker step for summary logging. */
export function getKeyUsageSummary(): string {
  if (keyUsage.size === 0) return 'no Gemini calls'
  const parts = Array.from(keyUsage.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => `${label}=${count}`)
  keyUsage.clear()
  return parts.join(' ')
}
