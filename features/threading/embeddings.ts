import { genAI, AI_MODELS } from "../shared/ai";

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!text || text.trim().length < 5) return null;

  try {
    const model = genAI.getGenerativeModel({ model: AI_MODELS.embeddings.model });
    const result = await model.embedContent(text);

    const values = result.embedding?.values;
    if (!values || !Array.isArray(values)) return null;

    return values;
  } catch (error) {
    console.error("Embedding generation failed:", error);
    return null;
  }
}
