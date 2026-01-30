// features/shared/ai.ts

import { GoogleGenerativeAI } from "@google/generative-ai";

export const AI_MODELS = {
  classification: 'gemini-2.5-flash',
  summarization: 'gemini-2.5-flash',
  writing: 'gemini-2.5-flash',
  whitelist: 'gemini-2.5-flash',
  whitelistBulk: 'gemini-2.5-flash-lite',
  embeddings: {
    model: 'models/text-embedding-004',
    dim: 768,
    taskType: 'SEMANTIC_SIMILARITY',
  },
} as const;

export const AI_CONFIG = {
  models: {
    smart: AI_MODELS.summarization,
    fast: AI_MODELS.writing,
    embedding: AI_MODELS.embeddings.model
  },
  whitelist: {
    bodyCharLimit: 300,
    temperature: 0.3,
  },
} as const;

if (!process.env.GEMINI_API_KEY) {
    console.warn("Missing GEMINI_API_KEY in environment variables.");
}

export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
export const ai = genAI;
