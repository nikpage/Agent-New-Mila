/**
 * AI Model Configuration
 * Maps each AI stage to a primary model + 2 fallbacks.
 * All Gemini for now — structure supports OpenAI/Anthropic later.
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
  // Pre-filter / spam — cheapest, fastest model
  preFilter: {
    primary: 'gemini-2.5-flash',
    fallback1: 'gemini-2.0-flash',
    fallback2: 'gemini-2.0-flash',
  },

  // Classification — email category + priority
  classify: {
    primary: 'gemini-2.5-flash',
    fallback1: 'gemini-2.0-flash',
    fallback2: 'gemini-2.0-flash',
  },

  // Threading — extractTopic, shouldJoinConversation
  threading: {
    primary: 'gemini-2.5-flash',
    fallback1: 'gemini-2.0-flash',
    fallback2: 'gemini-2.0-flash',
  },

  // Analysis — analyzeConversation
  analysis: {
    primary: 'gemini-2.5-flash',
    fallback1: 'gemini-2.0-flash',
    fallback2: 'gemini-2.0-flash',
  },

  // Planning — proposeAction
  planning: {
    primary: 'gemini-2.5-flash',
    fallback1: 'gemini-2.0-flash',
    fallback2: 'gemini-2.0-flash',
  },

  // Drafting — generateFinalDraft, generateBriefHeadline
  drafting: {
    primary: 'gemini-2.5-flash',
    fallback1: 'gemini-2.0-flash',
    fallback2: 'gemini-2.0-flash',
  },
}
