// features/classification/service.ts

import { genAI, AI_CONFIG } from "../shared/ai";
import { IngestedEmail } from "../ingestion/types";
import { SchemaType as Type } from "@google/generative-ai";

export async function classifyEmail(email: IngestedEmail) {
  const prompt = `Classify this email.
  From: ${email.from}
  Subject: ${email.subject}
  Body: ${email.bodyPlain.substring(0, 2000)}
  `;

  const model = genAI.getGenerativeModel({
    model: AI_CONFIG.models.fast,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          category: {
            type: Type.STRING,
            enum: ["BUSINESS", "PERSONAL", "SPAM", "NOTIFICATION"],
          },
          actionRequired: { type: Type.BOOLEAN },
          confidence: { type: Type.NUMBER },
          summary: { type: Type.STRING },
          event_details: {
            type: Type.OBJECT,
            properties: {
              is_event: { type: Type.BOOLEAN },
              requested_time: { type: Type.STRING },
              duration_minutes: { type: Type.NUMBER },
            },
            nullable: true,
          },
          summary_czech: { type: Type.STRING, nullable: true },
        },
        required: ["category", "actionRequired", "confidence"],
      },
    },
  });

  const response = await model.generateContent(prompt);
  const text = response.response.text();

  try {
    return JSON.parse(text || "{}");
  } catch (e) {
    console.error("Failed to parse classification JSON", text);
    return { category: "BUSINESS", actionRequired: false, confidence: 0 };
  }
}
