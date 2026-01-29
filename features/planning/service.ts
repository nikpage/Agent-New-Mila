// features/planning/service.ts

import { createClient } from '@supabase/supabase-js';
import { genAI, AI_CONFIG } from '../shared/ai';
import { ActionPlan } from './types';
import { SchemaType } from "@google/generative-ai";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!
);

/**
 * Time calculation helpers from Mila
 */
function toMs(ts?: string | Date | null): number | null {
  if (!ts) return null;
  const n = new Date(ts as any).getTime();
  return Number.isFinite(n) ? n : null;
}

function daysBetween(nowMs: number, thenMs: number | null): number {
  if (thenMs == null) return 0;
  const d = Math.floor((nowMs - thenMs) / (24 * 60 * 60 * 1000));
  return d < 0 ? 0 : d;
}

function computeFollowUpClocks(
  messages: Array<{ timestamp: string; direction: string }>,
  lastInteractionAt?: string | null
) {
  const nowMs = Date.now();
  const lastInteractionMs = toMs(lastInteractionAt);

  const inbound = messages
    .filter(m => m.direction.toUpperCase() === 'INBOUND')
    .map(m => toMs(m.timestamp))
    .filter((x): x is number => x != null)
    .sort((a, b) => b - a)[0] ?? null;

  const outbound = messages
    .filter(m => m.direction.toUpperCase() === 'OUTBOUND')
    .map(m => toMs(m.timestamp))
    .filter((x): x is number => x != null)
    .sort((a, b) => b - a)[0] ?? null;

  const effectiveInboundMs = inbound;
  const effectiveOutboundMs = Math.max(outbound ?? 0, lastInteractionMs ?? 0) || null;

  const agentOwes =
    effectiveInboundMs != null &&
    (effectiveOutboundMs == null || effectiveInboundMs > effectiveOutboundMs);

  const days_waiting_on_agent = agentOwes ? daysBetween(nowMs, effectiveInboundMs) : 0;

  return { days_waiting_on_agent };
}

/**
 * Analyzes a thread and determines the next best action.
 */
export async function planNextMove(
  threadId: string,
  lastMessageText: string
): Promise<ActionPlan> {

  // 1. Fetch Context (Summary + Last messages for context AND timing)
  const { data: thread } = await supabase
    .from('conversation_threads')
    .select('summary_json, topic')
    .eq('id', threadId)
    .single();

  // Increased limit to 10 to get better history for clocks
  const { data: recentMessages } = await supabase
    .from('messages')
    .select('direction, cleaned_text, timestamp')
    .eq('conversation_id', threadId)
    .order('timestamp', { ascending: false })
    .limit(10);

  // Messages for Context (just last 3)
  const contextStr = (recentMessages || [])
    .slice(0, 3)
    .reverse()
    .map(m => `[${m.direction}]: ${m.cleaned_text}`)
    .join('\n');

  const summaryStr = JSON.stringify(thread?.summary_json || {});

  // Calculate days_ignored
  const clocks = computeFollowUpClocks(recentMessages || []);
  const daysIgnored = clocks.days_waiting_on_agent;

  // 2. Prompt Gemini for Strategy
  const prompt = `
    You are an expert Real Estate Executive Assistant.
    Analyze this conversation and decide the next move.

    Topic: ${thread?.topic}
    Summary: ${summaryStr}
    Recent Log:
    ${contextStr}

    New Message: "${lastMessageText}"

    Task 1: Scoring (Strictly adhere to these definitions)
    - dollar_value: 1-13 (symbolic scale of financial impact).
    - urgency: 0-10.
    - pain_factor: 0-10.
    - weight: 0-10 for movable tasks, 100 for immovable deadlines.
    - offer_multiplier: 1.5 if property offer from owner, 1.0 otherwise.

    Task 2: Decision
    - Choose ACTION: REPLY, SCHEDULE, WAIT, DELEGATE, FILE.
    - If REPLY/SCHEDULE, provide drafting instructions.
  `;

  // Initialize model with specific configuration for structured output
  const model = genAI.getGenerativeModel({
    model: AI_CONFIG.models.smart,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          action: { type: SchemaType.STRING, enum: ['REPLY', 'SCHEDULE', 'WAIT', 'DELEGATE', 'FILE'] },
          confidence: { type: SchemaType.NUMBER },
          reasoning: { type: SchemaType.STRING },
          scores: {
            type: SchemaType.OBJECT,
            properties: {
              dollar_value: { type: SchemaType.NUMBER },
              urgency: { type: SchemaType.NUMBER },
              pain_factor: { type: SchemaType.NUMBER },
              weight: { type: SchemaType.NUMBER },
              offer_multiplier: { type: SchemaType.NUMBER }
            },
            required: ['dollar_value', 'urgency', 'pain_factor', 'weight', 'offer_multiplier']
          },
          draftingContext: {
            type: SchemaType.OBJECT,
            properties: {
              intent: { type: SchemaType.STRING },
              keyPoints: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
              tone: { type: SchemaType.STRING, enum: ['professional', 'urgent', 'friendly'] }
            }
          }
        },
        required: ['action', 'confidence', 'reasoning', 'scores']
      }
    }
  });

  const result = await model.generateContent(prompt);
  const responseText = result.response.text();

  if (!responseText) {
    throw new Error("AI failed to generate plan");
  }

  const rawPlan = JSON.parse(responseText);

  // Add days_ignored to scores
  rawPlan.scores.days_ignored = daysIgnored;

  // Calculate totalPriority derived from factors using Mila's Hybrid Scoring
  // Formula: (V_adjusted * U) + (P * (D + 1)^2) + W
  // V_adjusted = dollar_value * offer_multiplier

  const s = rawPlan.scores;
  const V_adjusted = s.dollar_value * s.offer_multiplier;
  const impact = V_adjusted * s.urgency;
  const personal = s.pain_factor * Math.pow(s.days_ignored + 1, 2);

  const totalPriority = impact + personal + s.weight;

  rawPlan.scores.totalPriority = Math.round(totalPriority);

  return rawPlan as ActionPlan;
}
