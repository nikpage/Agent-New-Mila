/**
 * AI Provider Interface
 * Each provider (Gemini, OpenAI, Anthropic) implements this.
 */

export interface AIGenerateOptions {
  temperature?: number
  thinkingBudget?: number
}

export interface AIUsage {
  inputTokens: number
  outputTokens: number
}

export interface AIResult {
  text: string
  usage?: AIUsage
}

export interface AIProvider {
  generateContent(model: string, prompt: string, options?: AIGenerateOptions): Promise<AIResult>
}
