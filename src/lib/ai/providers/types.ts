/**
 * AI Provider Interface
 * Each provider (Gemini, OpenAI, Anthropic) implements this.
 */

export interface AIProvider {
  generateContent(model: string, prompt: string): Promise<string>
}
