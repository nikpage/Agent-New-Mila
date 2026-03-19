/**
 * Gemini AI Provider
 * Wraps @google/generative-ai SDK behind the AIProvider interface.
 *
 * Key rotation is handled by the shared gemini-keys module —
 * same round-robin pool as embeddings and any other Gemini caller.
 */

import type { GenerativeModel } from '@google/generative-ai'
import type { AIProvider, AIGenerateOptions } from './types'
import { getNextClient } from './gemini-keys'

const modelCaches = new Map<number, Map<string, GenerativeModel>>()
const keyUsage = new Map<string, number>()

function getModel(modelName: string): { model: GenerativeModel; keyLabel: string; fingerprint: string } {
  const { client, keyIndex, keyLabel, fingerprint } = getNextClient()

  if (!modelCaches.has(keyIndex)) {
    modelCaches.set(keyIndex, new Map())
  }
  const cache = modelCaches.get(keyIndex)!
  if (!cache.has(modelName)) {
    cache.set(modelName, client.getGenerativeModel({ model: modelName }))
  }
  return { model: cache.get(modelName)!, keyLabel, fingerprint }
}

let lastKeyLabel: string | null = null
let lastFingerprint: string | null = null
export function getLastKeyLabel(): string | null { return lastKeyLabel }
export function getLastFingerprint(): string | null { return lastFingerprint }

export const geminiProvider: AIProvider = {
  async generateContent(model: string, prompt: string, options?: AIGenerateOptions): Promise<string> {
    const { model: m, keyLabel, fingerprint } = getModel(model)
    const genConfig: Record<string, unknown> = {}
    if (options?.temperature !== undefined) genConfig.temperature = options.temperature
    if (options?.thinkingBudget) genConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget }
    const result = await m.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: Object.keys(genConfig).length > 0 ? genConfig : undefined,
    })
    keyUsage.set(keyLabel, (keyUsage.get(keyLabel) || 0) + 1)
    lastKeyLabel = keyLabel
    lastFingerprint = fingerprint
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
