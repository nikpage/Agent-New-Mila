/**
 * AI Model Configuration
 * Maps each AI stage to a primary model + 2 fallbacks.
 * Gemini primary, Claude (Anthropic) fallbacks.
 */

export type AIStage =
  | 'preFilter'
  | 'classify'
  | 'threading'
  | 'analysis'
  | 'planning'
  | 'drafting'

export interface ModelChain {
  primary: string
  fallback1: string
  fallback2: string
}

export const AI_TASK_MODELS: Record<AIStage, ModelChain> = {
  // Pre-filter / spam — lite model (fast, cheap)
  preFilter: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'gemini-2.5-flash',
    fallback2: 'claude-haiku-4-5-20251001',
  },

  // Classification — email category + priority
  classify: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'gemini-2.5-flash',
    fallback2: 'claude-haiku-4-5-20251001',
  },

  // Threading — extractTopic, shouldJoinConversation
  threading: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: 'claude-haiku-4-5-20251001',
  },

  // Analysis — analyzeConversation
  analysis: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: 'claude-haiku-4-5-20251001',
  },

  // Planning — proposeAction
  planning: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: 'claude-haiku-4-5-20251001',
  },

  // Drafting — generateFinalDraft, generateBriefHeadline
  drafting: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: 'claude-haiku-4-5-20251001',
  },
}
