/**
 * Gemini AI Provider
 * Wraps @google/generative-ai SDK behind the AIProvider interface.
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai'
import type { AIProvider } from './types'

let genAI: GoogleGenerativeAI | null = null
const modelCache = new Map<string, GenerativeModel>()

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
    genAI = new GoogleGenerativeAI(apiKey)
  }
  return genAI
}

function getModel(modelName: string): GenerativeModel {
  if (!modelCache.has(modelName)) {
    const client = getClient()
    modelCache.set(modelName, client.getGenerativeModel({ model: modelName }))
  }
  return modelCache.get(modelName)!
}

export const geminiProvider: AIProvider = {
  async generateContent(model: string, prompt: string): Promise<string> {
    const m = getModel(model)
    const result = await m.generateContent(prompt)
    return result.response.text()
  },
}
