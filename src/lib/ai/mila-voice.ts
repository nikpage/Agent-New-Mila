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
  rationale: string,
  dollarValue: number,
  recentContext: string,
  settings: UserSettings
): Promise<{ intent_cs: string; missingInfo: { label: string; value: null }[] }> {
  const prompt = `You are Mila, a proactive executive assistant. Write an intent_cs for a SCHEDULE action card that will appear in the user's morning brief email.

TONE: ${settings.ai_tone_user}

CRITICAL — URGENCY HANDLING:
Urgency is ${urgency}/10.
- 9-10: THIS IS A CRISIS. Lead with the deadline or consequence. Name what the user will lose if they don't act NOW. Be direct, sharp, no pleasantries.
- 7-8: Significant pressure. Mention the time sensitivity and stakes clearly.
- 4-6: Standard professional. Note the meeting details clearly.
- 1-3: Routine. Brief and calm.

BUSINESS CONTEXT:
- Why this matters: ${rationale}
- Deal value: ${dollarValue > 0 ? `${dollarValue.toLocaleString()} ${settings.typical_deal_size_currency}` : 'unknown'}
- Recent conversation: ${recentContext}

COUNTERPARTY: ${cpName}

WHAT MILA HAS DONE:
- Original plan: ${originalIntent}
- Slot booked: ${scheduling.hasHold ? scheduling.slotText : 'NO FREE SLOT FOUND'}
${scheduling.conflicts?.length ? `- Calendar conflicts: ${scheduling.conflicts.map(c => `${c.name} (${c.recommendation === 'move_existing' ? 'can be moved' : 'IMMOVABLE'})`).join(', ')}` : '- No conflicts'}
- Location: ${scheduling.locationStatus === 'confirmed' ? scheduling.locationText : scheduling.locationStatus === 'partial' ? `${scheduling.locationText} (unverified)` : 'not specified'}

RULES:
- Output in CZECH. Plain text only. No markdown.
- Address user as "vy" (you). Never "uživatel".
- intent_cs: Combine the business stakes with the scheduling details. A human assistant wouldn't just say "I blocked a slot" — she'd say "Novotný needs signature by 5pm or the deal falls through. I blocked 9:00 at the notary."
- Do NOT include the slot date/time separately (no "Termín: ..." line). The time is displayed by the card template. You can reference the time naturally in the narrative (e.g. "Rezervovala jsem hovor v 9:30") but do NOT repeat it as a standalone line.
- missingInfo: array of questions. Each has "label" (full question in Czech) and "value": null.
${scheduling.locationStatus === 'missing' ? '- Location is missing — include a question about meeting location.' : ''}
${scheduling.locationStatus === 'partial' ? '- Location unverified — include a question to clarify.' : ''}
${!scheduling.hasHold ? '- No slot found — include a question asking for preferred time.' : ''}

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
  pendingActions: { type: string; cpName: string; urgency: number; intent: string; dollarValue: number }[],
  settings: UserSettings
): Promise<{ greeting: string; subject: string; headline: string }> {
  const eventsText = events.length > 0
    ? events.map(e => `${e.time}: ${e.title}`).join('\n')
    : 'No meetings scheduled'
  const actionsText = pendingActions
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 5)
    .map(a => `${a.type} for ${a.cpName} (urgency: ${a.urgency}/10${a.dollarValue > 0 ? `, value: ${a.dollarValue.toLocaleString()}` : ''}): ${a.intent}`)
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
- headline: 2-3 sentences. Lead with the MOST URGENT item — if there's an urgency 9-10 action, that dominates the headline, not the calendar. A human assistant wouldn't mention swimming when the house is on fire.

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
  topAction: { cpName: string; urgency: number; actionType: string; intent: string; dollarValue: number },
  settings: UserSettings
): Promise<{ subject: string; header: string; body: string }> {
  const prompt = `You are Mila sending an urgent notification email. Generate an email subject, header text, and a one-sentence body.

TONE: ${settings.ai_tone_user}
This is high-priority — urgency score exceeded threshold. Tone should reflect urgency.

DETAILS:
- Number of urgent actions: ${actionCount}
- Top action: ${topAction.actionType} for ${topAction.cpName} (urgency: ${topAction.urgency}/10)
- What needs attention: ${topAction.intent}
- Deal value: ${topAction.dollarValue > 0 ? `${topAction.dollarValue.toLocaleString()}` : 'unknown'}

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
- Addresses in email signatures are the SENDER's company address, not the property or meeting location. Do not treat them as conflicting with addresses mentioned in the message body.

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

/**
 * Generate a conflict resolution draft — reschedule or cancel notification to CP/guests.
 * Only called when existing event has guests/CP that need to be informed.
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateConflictResolutionDraft(
  resolutionType: 'reschedule' | 'cancel',
  existingEventTitle: string,
  existingEventTime: string,
  newTime: string | null,
  cpName: string,
  dealContext: string | null,
  settings: UserSettings
): Promise<{ subject: string; body: string }> {
  console.log(`[AI:generateConflictResolutionDraft] ${resolutionType} for "${existingEventTitle}" → ${cpName}`)
  const systemContext = getAISystemPrompt(settings)

  const prompt = `${systemContext}

You are an executive assistant writing an email on behalf of your boss to inform a counterparty about a scheduling change.

TONE: ${settings.ai_tone_cp}
Language: CZECH.

RESOLUTION TYPE: ${resolutionType === 'reschedule' ? 'RESCHEDULE — the meeting is being moved to a new time' : 'CANCEL — the meeting is being cancelled'}

DETAILS:
- Event: ${existingEventTitle}
- Original time: ${existingEventTime}
${resolutionType === 'reschedule' && newTime ? `- New time: ${newTime}` : ''}
- Counterparty: ${cpName}
${dealContext ? `- Deal context: ${dealContext}` : ''}

RULES:
- Output in CZECH. Plain text only.
- Sign off with: ${settings.ai_email_signature}
${resolutionType === 'reschedule'
    ? '- Politely inform about the time change, apologize for the inconvenience, confirm the new time.'
    : '- Politely cancel the meeting, apologize, offer to reschedule if appropriate.'}
- Keep it concise — 3-5 sentences max.

Respond with ONLY valid JSON:
{
  "subject": "Email subject line",
  "body": "Email body text (ready to send)"
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    // Fallback — never leave the user without a draft
    return resolutionType === 'reschedule'
      ? { subject: `Přesunutí schůzky: ${existingEventTitle}`, body: `Dobrý den,\n\nomlouvám se, ale potřebuji přesunout naši schůzku "${existingEventTitle}"${newTime ? ` na ${newTime}` : ''}.\n\nDěkuji za pochopení.\n\n${settings.ai_email_signature}` }
      : { subject: `Zrušení schůzky: ${existingEventTitle}`, body: `Dobrý den,\n\nomlouvám se, ale musím zrušit naši schůzku "${existingEventTitle}".\n\nDěkuji za pochopení.\n\n${settings.ai_email_signature}` }
  }
  return JSON.parse(jsonMatch[0])
}
