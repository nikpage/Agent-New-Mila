// features/inbox/agent.ts

import { GoogleGenAI } from "@google/genai";
import { RawEmail, EmailAnalysis } from "./types";

/**
 * Inbox Agent
 * Responsible for "thinking" about incoming emails.
 * This function is called by the Ingestion Trigger.
 */
export async function processIncomingEmail(email: RawEmail): Promise<EmailAnalysis> {
  // 1. Initialize Gemini
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  // 2. Construct the Prompt (System Instruction)
  // We explicitly tell the AI it is an Executive Assistant (Pepper Potts style).
  const systemInstruction = `
    You are an elite Executive Assistant for a high-end Real Estate Agent.
    Your goal is to process incoming emails and extract structured data.

    Rules:
    - Identify if the email is from a known Counterparty (Lawyer, Photographer, etc).
    - Determine priority based on urgency (Closing dates are HIGH priority).
    - Extract concrete tasks (e.g., "Sign document", "Confirm time").
    - If it's spam or irrelevant, mark priority as 'low'.
  `;

  // 3. Call the Model
  // We use the flash model for speed on ingestion tasks.
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Analyze this email:\nFrom: ${email.from}\nSubject: ${email.subject}\nBody: ${email.bodyPlain}`,
    config: {
      systemInstruction: systemInstruction,
      responseMimeType: "application/json",
      // We enforce a strict JSON schema for the output
      responseSchema: {
        type: 'OBJECT',
        properties: {
          isImportant: { type: 'BOOLEAN' },
          priority: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          summary: { type: 'STRING' },
          suggestedAction: { type: 'STRING', enum: ['reply', 'schedule_meeting', 'file_away', 'urgent_review'] },
          extractedTasks: {
            type: 'ARRAY',
            items: { type: 'STRING' }
          },
          sentiment: { type: 'STRING', enum: ['positive', 'neutral', 'negative'] }
        },
        required: ['isImportant', 'priority', 'summary', 'suggestedAction', 'extractedTasks']
      }
    }
  });

  // 4. Parse and Return
  // The response is guaranteed to be JSON due to responseMimeType
  const analysis = JSON.parse(response.text || '{}') as EmailAnalysis;
  return analysis;
}
