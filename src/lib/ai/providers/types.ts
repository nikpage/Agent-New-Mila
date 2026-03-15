/**
 * AI Provider Interface
 * Each provider (Gemini, OpenAI, Anthropic) implements this.
 */

export interface AIGenerateOptions {
  temperature?: number
  thinkingBudget?: number
}

export interface AIProvider {
  generateContent(model: string, prompt: string, options?: AIGenerateOptions): Promise<string>
}
