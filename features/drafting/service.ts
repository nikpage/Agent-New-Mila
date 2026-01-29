// features/drafting/service.ts

import { ai, AI_CONFIG } from '../shared/ai';
import { ActionPlan } from '../planning/types';

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

  const response = await ai.models.generateContent({
    model: AI_CONFIG.models.fast, // Use fast model for writing
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: 'OBJECT',
        properties: {
          subject: { type: 'STRING' },
          body: { type: 'STRING' }
        },
        required: ['subject', 'body']
      }
    }
  });

  if (!response.text) return { subject: "Draft Generation Failed", body: "" };

  return JSON.parse(response.text) as DraftResult;
}
