import { genAI, AI_MODELS } from "../shared/ai";
import { RawEmail, EmailAnalysis } from "./types";
import { SchemaType } from "@google/generative-ai";

export async function processIncomingEmail(email: RawEmail): Promise<EmailAnalysis> {
  const model = genAI.getGenerativeModel({ 
    model: AI_MODELS.classification,
    generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
            type: SchemaType.OBJECT,
            properties: {
                isImportant: { type: SchemaType.BOOLEAN },
                priority: { type: SchemaType.STRING, enum: ['high', 'medium', 'low'] },
                summary: { type: SchemaType.STRING },
                suggestedAction: { type: SchemaType.STRING, enum: ['reply', 'schedule_meeting', 'file_away', 'urgent_review'] },
                extractedTasks: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                sentiment: { type: SchemaType.STRING, enum: ['positive', 'neutral', 'negative'] }
            },
            required: ['isImportant', 'priority', 'summary', 'suggestedAction', 'extractedTasks']
        }
    }
  });

  const prompt = `Analyze this email:\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${email.bodyPlain}`;
  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text()) as EmailAnalysis;
}
