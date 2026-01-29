import { GoogleGenerativeAI } from "@google/generative-ai";

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

export const AI_PROMPTS = {
  classify: `ACT AS: Expert Executive Assistant...`,
  threadSummary: `You are a Real Estate Assistant...`,
} as const;

if (!process.env.GEMINI_API_KEY) {
    console.warn("Missing GEMINI_API_KEY in environment variables.");
}

export const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
// Alias for backward compatibility in some files
export const ai = genAI;
