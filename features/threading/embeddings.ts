// features/threading/embeddings.ts

import { ai, AI_CONFIG } from "../shared/ai";

/**
 * Generates a 768-dimensional vector embedding for a given text.
 * Uses 'text-embedding-004'.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!text || text.trim().length < 5) return null;

  try {
    const result = await ai.models.embedContent({
      model: AI_CONFIG.models.embedding,
      content: text,
    });

    const values = result.embedding?.values;
    if (!values || !Array.isArray(values)) return null;

    return values;
  } catch (error) {
    console.error("Embedding generation failed:", error);
    return null;
  }
}
