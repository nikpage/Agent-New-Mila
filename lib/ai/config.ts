// lib/ai/config.ts

export const AI_MODELS = {
  classification: 'gemini-2.5-flash',
  summarization: 'gemini-2.5-flash',
  writing: 'gemini-2.5-flash',
  whitelist: 'gemini-2.5-flash',
  whitelistBulk: 'gemini-2.5-flash-lite',
  embeddings: {
    model: 'models/gemini-embedding-001',
    dim: 768,
    purpose: 'semantic-search',
    language: 'multilingual',
  },
} as const;

export const AI_CONFIG = {
  whitelist: {
    bodyCharLimit: 300,
    temperature: 0.3,
  },
} as const;
