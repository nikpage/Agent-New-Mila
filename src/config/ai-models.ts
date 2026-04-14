/**
 * AI Model Configuration
 * Maps each AI stage to a primary model + 1 fallback.
 * Gemini primary, Claude (Anthropic) fallback.
 * 3rd slot reserved — currently unused.
 */

export type AIStage =
  | 'filter'
  | 'classify'
  | 'enrichment'
  | 'threading'
  | 'analysis'
  | 'triage_extract'
  | 'triage'
  | 'triage_verify'
  | 'drafting'
  | 'reflection'
  | 'draft_edit'
  | 'contradiction_analysis'
  | 'contradiction_escalation'
  | 'belief_audit'
  | 'temporal'
  | 'extraction'
  | 'reconstruction_critic'
  | 'graph_proposal'
  | 'bypass'

export interface ModelChain {
  primary: string
  fallback1: string
  fallback2: string | null
  temperature?: number
  thinkingBudget?: number
}

export const AI_TASK_MODELS: Record<AIStage, ModelChain> = {
  // Filter / spam — deterministic (temperature 0)
  filter: {
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
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-haiku-4-5-20251001',
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

  // Triage extraction — pure reading comprehension, deterministic
  triage_extract: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'claude-haiku-4-5-20251001',
    fallback2: null,
    temperature: 0,
  },

  // Triage — decision-only (receives verified facts from extraction, not raw email)
  triage: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
    thinkingBudget: 4096,
  },

  // Triage verification — cheap cross-check against source message
  triage_verify: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'claude-haiku-4-5-20251001',
    fallback2: null,
    temperature: 0,
  },

  // Drafting — generateFinalDraft, generateBriefHeadline
  drafting: {
    primary: 'claude-sonnet-4-6',
    fallback1: 'gemini-2.5-flash',
    fallback2: null,
  },

  // Reflection — journal observation extraction (Haiku primary for reliable Czech)
  reflection: {
    primary: 'claude-haiku-4-5-20251001',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
    temperature: 0,
  },

  // Draft edit — gap-fill + spell/grammar on user save (Haiku primary for reliable Czech)
  draft_edit: {
    primary: 'claude-haiku-4-5-20251001',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
    temperature: 0,
  },

  // Contradiction analysis — resolve conflicting beliefs (thinking enabled)
  contradiction_analysis: {
    primary: 'claude-sonnet-4-6',
    fallback1: 'gemini-2.5-flash',
    fallback2: null,
    thinkingBudget: 4096,
  },

  // Contradiction escalation — Opus fallback for unresolved contradictions
  contradiction_escalation: {
    primary: 'claude-opus-4-6',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
    thinkingBudget: 8192,
  },

  // Belief audit — monthly/quarterly full belief review
  belief_audit: {
    primary: 'claude-opus-4-6',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
    thinkingBudget: 8192,
  },

  // Temporal extraction — LLM generates DSL code from Czech time expressions
  temporal: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-haiku-4-5-20251001',
    fallback2: null,
    temperature: 0,
  },

  // Fact & belief extraction — unified enrichment + facts in one scratchpad-first call
  extraction: {
    primary: 'gemini-2.5-flash',
    fallback1: 'claude-sonnet-4-6',
    fallback2: null,
    temperature: 0,
  },

  // Reconstruction critic — QA pass: what did the extractor miss?
  reconstruction_critic: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'claude-haiku-4-5-20251001',
    fallback2: null,
    temperature: 0,
  },

  // Graph proposal — novel edge inference for unmatched facts (rare, needs reasoning)
  graph_proposal: {
    primary: 'claude-sonnet-4-6',
    fallback1: 'gemini-2.5-flash',
    fallback2: null,
  },

  // Bypass filter — emergency detection, cheapest+fastest possible
  bypass: {
    primary: 'gemini-2.5-flash-lite',
    fallback1: 'claude-haiku-4-5-20251001',
    fallback2: null,
    temperature: 0,
  },
}
