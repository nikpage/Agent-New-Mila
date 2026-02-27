/**
 * AI Model Configuration
 * Maps each AI stage to a primary model + 1 fallback.
 * Gemini primary, Claude (Anthropic) fallback.
 * 3rd slot reserved — currently unused.
 */

export type AIStage =
  | 'preFilter'
  | 'classify'
  | 'enrichment'
  | 'threading'
  | 'analysis'
  | 'planning'
  | 'drafting'

export interface ModelChain {
  primary: string
  fallback1: string
  fallback2: string | null
  temperature?: number
}

export const AI_TASK_MODELS: Record<AIStage, ModelChain> = {
  // Pre-filter / spam — deterministic (temperature 0)
  preFilter: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'claude-haiku-4-5-20251001',
    fallback2: null,
    temperature: 0,
  },

  // Classification — deterministic (temperature 0)
  classify: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'claude-haiku-4-5-20251001',
    fallback2: null,
    temperature: 0,
  },

  // Enrichment — deterministic (temperature 0)
  enrichment: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'gemini-2.5-flash',
    fallback2: null,
    temperature: 0,
  },

  // Threading — deterministic (temperature 0)
  threading: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
    temperature: 0,
  },

  // Analysis — analyzeConversation
  analysis: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
  },

  // Planning — proposeAction
  planning: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
  },

  // Drafting — generateFinalDraft, generateBriefHeadline
  drafting: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
  },
}
