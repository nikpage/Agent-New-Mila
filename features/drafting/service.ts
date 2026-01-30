// features/drafting/service.ts
import { genAI, AI_CONFIG } from '../shared/ai';
import { ActionPlan } from '../planning/types';
import { SchemaType as Type } from "@google/generative-ai";

export interface DraftResult {
  subject: string;
  body: string;
}

export async function generateDraft(
  senderName: string,
  plan: ActionPlan,
  threadSummary: any
): Promise<DraftResult> {
  if (!plan.draftingContext) {
    return { subject: "", body: "" };
  }

  const prompt = `
    Write a email for a Real Estate Agent.
    Recipient: ${senderName}
    Intent: ${plan.draftingContext.intent}
    Key Points to Hit:
    ${plan.draftingContext.keyPoints.map(p => `- ${p}`).join('\n')}
    Tone: ${plan.draftingContext.tone}

    Context:
    ${JSON.stringify(threadSummary)}

    Output pure JSON with subject and body.
  `;

  const model = genAI.getGenerativeModel({
    model: AI_CONFIG.models.fast,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING },
          body: { type: Type.STRING }
        },
        required: ['subject', 'body']
      }
    }
  });

  const response = await model.generateContent(prompt);
  const text = response.response.text();

  if (!text) return { subject: "Draft Generation Failed", body: "" };

  return JSON.parse(text) as DraftResult;
}
