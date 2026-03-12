import type { UserSettings } from '../supabase/types'
import { runAITask } from './runner'
import { getAISystemPrompt } from '@/config/client'

/**
 * Centralized Mila text generation — ALL user-facing + CP-facing text.
 * Every function uses stage 'drafting' via runAITask().
 */

/**
 * Rewrite an AI intent incorporating scheduling details.
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateSchedulingIntent(
  originalIntent: string,
  scheduling: {
    slotText: string
    hasConflicts: boolean
    conflicts?: { name: string; recommendation: 'move_existing' | 'suggest_alternate' }[]
    hasHold: boolean
    locationStatus: 'confirmed' | 'partial' | 'missing' | null
    locationText?: string | null
  },
  cpName: string,
  urgency: number,
  settings: UserSettings
): Promise<{ intent_cs: string; missingInfo: { label: string; value: null }[] }> {
  const prompt = `You are Mila, a proactive executive assistant. Rewrite this scheduling intent incorporating the scheduling details below. Keep the original context and add the slot/conflict/location info naturally.

TONE: ${settings.ai_tone_user}
Urgency is ${urgency}/10. Adjust your tone — 9-10 is house on fire, 1-3 is routine.

ORIGINAL INTENT:
${originalIntent}

COUNTERPARTY: ${cpName}

SCHEDULING DETAILS:
- Has hold in calendar: ${scheduling.hasHold}
- Slot: ${scheduling.slotText || 'No free slot found'}
- Has conflicts: ${scheduling.hasConflicts}
${scheduling.conflicts?.length ? `- Conflicts: ${scheduling.conflicts.map(c => `${c.name} (${c.recommendation})`).join(', ')}` : ''}
- Location status: ${scheduling.locationStatus || 'unknown'}
${scheduling.locationText ? `- Location: ${scheduling.locationText}` : ''}

RULES:
- Output in CZECH. Plain text only. No markdown.
- Address user as "vy" (you). Never "uživatel".
- intent_cs: describe what Mila HAS DONE and what she WILL DO when user clicks UDĚLAT. Be specific.
- missingInfo: array of questions for the user. Each item has "label" (full question in Czech) and "value": null.
${scheduling.locationStatus === 'missing' ? '- Location is missing — include a question about meeting location in missingInfo.' : ''}
${scheduling.locationStatus === 'partial' ? '- Location could not be verified — include a question to clarify the location in missingInfo.' : ''}
${!scheduling.hasHold ? '- No free slot was found — include a question asking for preferred meeting time in missingInfo.' : ''}

Respond with ONLY valid JSON:
{
  "intent_cs": "...",
  "missingInfo": [{"label": "...", "value": null}]
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { intent_cs: originalIntent, missingInfo: [] }
  }
  const parsed = JSON.parse(jsonMatch[0])
  return {
    intent_cs: parsed.intent_cs || originalIntent,
    missingInfo: Array.isArray(parsed.missingInfo) ? parsed.missingInfo : [],
  }
}

/**
 * Generate follow-up intent and rationale for a stale lead.
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateLeadFollowUpIntent(
  status: 'cooling' | 'cold' | 'dead',
  cpName: string,
  daysSinceActivity: number,
  topic: string,
  channel: string,
  followUpNumber: number,
  settings: UserSettings
): Promise<{ intentCs: string; rationaleCs: string }> {
  const prompt = `You are Mila, a proactive executive assistant. A lead has gone ${status}. Write intent_cs (what you'll do) and rationale_cs (why it matters now).

TONE: ${settings.ai_tone_user}
Lead status: ${status} (dead = very urgent last-chance, cold = urgent follow-up, cooling = gentle check-in)

DETAILS:
- Counterparty: ${cpName}
- Days inactive: ${daysSinceActivity}
- Conversation topic: ${topic}
- Channel: ${channel}
- Follow-up number: ${followUpNumber + 1}

RULES:
- Output in CZECH. Plain text only. No markdown.
- Address user as "vy" (you). Never "uživatel".
- intent_cs: describe what Mila will prepare (the follow-up message). Be specific about the channel and topic.
- rationale_cs: one sentence explaining why this follow-up matters now.

Respond with ONLY valid JSON:
{
  "intentCs": "...",
  "rationaleCs": "..."
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return {
      intentCs: `Připravím follow-up pro ${cpName} přes ${channel}.`,
      rationaleCs: `${daysSinceActivity} dní bez aktivity.`,
    }
  }
  return JSON.parse(jsonMatch[0])
}

/**
 * Generate brief intro (greeting, subject, headline) for morning/afternoon brief.
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateBriefIntro(
  briefType: 'morning' | 'afternoon',
  actionCount: number,
  events: { title: string; time: string }[],
  pendingActions: { type: string; cpName: string; urgency: number }[],
  settings: UserSettings
): Promise<{ greeting: string; subject: string; headline: string }> {
  const eventsText = events.length > 0
    ? events.map(e => `${e.time}: ${e.title}`).join('\n')
    : 'No meetings scheduled'
  const actionsText = pendingActions
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 5)
    .map(a => `${a.type} for ${a.cpName} (urgency: ${a.urgency})`)
    .join('\n')

  const prompt = `You are Mila writing a ${briefType} brief email. Generate a greeting, email subject line, and a 2-3 sentence headline.

TONE: ${settings.ai_tone_user}

TODAY'S SCHEDULE:
${eventsText}

PENDING ACTIONS (${actionCount} total):
${actionsText}

RULES:
- Output in CZECH. Plain text only. No markdown.
- Address user as "vy" (you). Never "uživatel".
- greeting: a natural ${briefType === 'morning' ? 'morning' : 'afternoon'} greeting. Do NOT hardcode — let it be natural.
- subject: concise email subject. Include action count naturally.
- headline: 2-3 sentence summary of what matters today. Be warm but professional.

Respond with ONLY valid JSON:
{
  "greeting": "...",
  "subject": "...",
  "headline": "..."
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse brief intro')
  return JSON.parse(jsonMatch[0])
}

/**
 * Generate urgent notification intro (subject, header, body).
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateUrgentIntro(
  actionCount: number,
  topAction: { cpName: string; urgency: number; actionType: string },
  settings: UserSettings
): Promise<{ subject: string; header: string; body: string }> {
  const prompt = `You are Mila sending an urgent notification email. Generate an email subject, header text, and a one-sentence body.

TONE: ${settings.ai_tone_user}
This is high-priority — urgency score exceeded threshold. Tone should reflect urgency.

DETAILS:
- Number of urgent actions: ${actionCount}
- Top action: ${topAction.actionType} for ${topAction.cpName} (urgency: ${topAction.urgency}/10)

RULES:
- Output in CZECH. Plain text only. No markdown.
- Address user as "vy" (you). Never "uživatel".
- subject: concise, conveys urgency
- header: short header for the email
- body: one sentence describing what needs immediate attention

Respond with ONLY valid JSON:
{
  "subject": "...",
  "header": "...",
  "body": "..."
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse urgent intro')
  return JSON.parse(jsonMatch[0])
}

/**
 * Generate the Final Draft (Just-In-Time)
 * Moved from gemini.ts — CP-facing email/WhatsApp draft.
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateFinalDraft(
  conversationContext: any,
  intent: string,
  settings: UserSettings,
  userNotes?: string,
  missingInfo?: any[],
  cpName?: string,
  channel: 'email' | 'whatsapp' = 'email'
): Promise<{ subject: string; body: string }> {
  console.log(`[AI:generateFinalDraft] Running stage 'drafting' for ${cpName || 'unknown CP'}`)
  const systemContext = getAISystemPrompt(settings)
  const isWhatsApp = channel === 'whatsapp'
  const toneInstruction = isWhatsApp
    ? 'Write a short WhatsApp message. No subject line needed — set subject to empty string. Keep it conversational but professional.'
    : `Write a professional email in CZECH.\nSign off with:\n${settings.ai_email_signature}`

  const prompt = `${systemContext}

You are an executive assistant writing a ${isWhatsApp ? 'WhatsApp message' : 'email'} on behalf of your boss.
Language: CZECH.

CONTEXT:
${JSON.stringify(conversationContext, null, 2)}

THE PLAN (INTENT):
${intent}

${userNotes ? `USER NOTES (Override the plan if needed):
${userNotes}` : ''}

${missingInfo && missingInfo.length > 0 ? `SPECIFIC DATA PROVIDED BY USER:
${JSON.stringify(missingInfo)}` : ''}

RECIPIENT: ${cpName || 'The Counterparty'}

${toneInstruction}
- Use the specific data provided in the missingInfo section to answer the counterparty's questions.
- If the plan implies scheduling, propose the specific times mentioned.

Respond with ONLY valid JSON:
{
  "subject": "Email subject line${isWhatsApp ? ' (empty string for WhatsApp)' : ''}",
  "body": "${isWhatsApp ? 'WhatsApp message text' : 'Email body text'} (ready to send)"
}`

  const text = await runAITask('drafting', prompt)

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse draft reply')

  return JSON.parse(jsonMatch[0])
}
