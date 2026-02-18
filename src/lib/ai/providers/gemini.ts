/**
 * Gemini AI Provider
 * Wraps @google/generative-ai SDK behind the AIProvider interface.
 *
 * Supports multiple API keys via GEMINI_API_KEYS (comma-separated).
 * Falls back to single GEMINI_API_KEY if GEMINI_API_KEYS is not set.
 * Round-robins across keys to spread rate-limit budget.
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai'
import type { AIProvider } from './types'

let clients: GoogleGenerativeAI[] = []
let callIndex = 0
const modelCaches = new Map<number, Map<string, GenerativeModel>>()

function initClients(): GoogleGenerativeAI[] {
  if (clients.length > 0) return clients

  const multiKeys = process.env.GEMINI_API_KEYS
  const keys = multiKeys
    ? multiKeys.split(',').map(k => k.trim()).filter(Boolean)
    : []

  if (keys.length === 0) {
    const singleKey = process.env.GEMINI_API_KEY
    if (!singleKey) throw new Error('GEMINI_API_KEY or GEMINI_API_KEYS not configured')
    keys.push(singleKey)
  }

  clients = keys.map(key => new GoogleGenerativeAI(key))
  console.log(`[Gemini] Initialized ${clients.length} API key(s)`)
  return clients
}

function getModel(modelName: string): GenerativeModel {
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
  return cache.get(modelName)!
}

export const geminiProvider: AIProvider = {
  async generateContent(model: string, prompt: string): Promise<string> {
    const m = getModel(model)
    const result = await m.generateContent(prompt)
    return result.response.text()
  },
}
