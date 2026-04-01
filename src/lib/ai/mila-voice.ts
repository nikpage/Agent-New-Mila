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
- Output in ${settings.ai_language || 'Czech'}. Plain text only. No markdown.
- Address user as "vy" (you). Never "uživatel".
- intent_cs: Combine the business stakes with the scheduling details. A human assistant wouldn't just say "I blocked a slot" — she'd say "Novotný needs signature by 5pm or the deal falls through. I blocked 9:00 at the notary."
- Do NOT include the slot date/time separately (no "Termín: ..." line). The time is displayed by the card template. You can reference the time naturally in the narrative (e.g. "Rezervovala jsem hovor v 9:30") but do NOT repeat it as a standalone line.
- missingInfo: array of questions. Each has "label" (full question in ${settings.ai_language || 'Czech'}) and "value": null.
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
- Output in ${settings.ai_language || 'Czech'}. Plain text only. No markdown.
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
- Output in ${settings.ai_language || 'Czech'}. Plain text only. No markdown.
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
 * Generate a "quiet brief" — sent when there are no pending actions.
 * AI-generated, warm, mentions upcoming events/todos if any.
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateQuietBriefIntro(
  briefType: 'morning' | 'afternoon',
  events: { title: string; time: string }[],
  todos: { title: string; due?: string }[],
  settings: UserSettings
): Promise<{ greeting: string; subject: string; body: string }> {
  const eventsText = events.length > 0
    ? events.map(e => `${e.time}: ${e.title}`).join('\n')
    : 'No meetings scheduled'
  const todosText = todos.length > 0
    ? todos.map(t => `${t.title}${t.due ? ` (due: ${t.due})` : ''}`).join('\n')
    : 'No pending todos'

  const prompt = `You are Mila writing a ${briefType} brief email. There are NO pending action proposals — the inbox is clear. Write a warm, short "all clear" email.

TONE: ${settings.ai_tone_user}

TODAY'S SCHEDULE:
${eventsText}

UPCOMING TODOS:
${todosText}

RULES:
- Output in ${settings.ai_language || 'Czech'}. Plain text only. No markdown.
- Address user as "vy" (you). Never "uživatel".
- greeting: a natural ${briefType === 'morning' ? 'morning' : 'afternoon'} greeting.
- subject: concise email subject — convey "nothing urgent" positively. No fake urgency.
- body: 3-5 sentences. Start with a positive note that the inbox is clear. Then briefly mention today's schedule if there are meetings, or upcoming todos if any. End on an encouraging note. Keep it human and warm — not a form template.
- Do NOT invent fake tasks or actions. Only reference the schedule and todos provided above.

Respond with ONLY valid JSON:
{
  "greeting": "...",
  "subject": "...",
  "body": "..."
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse quiet brief intro')
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
  const lang = settings.ai_language || 'Czech'
  const prompt = `You are Mila sending an urgent notification email. Generate an email subject, header text, and a one-sentence body.

TONE: ${settings.ai_tone_user}
This is high-priority — urgency score exceeded threshold. Tone should reflect urgency.

DETAILS:
- Number of urgent actions: ${actionCount}
- Top action: ${topAction.actionType} for ${topAction.cpName} (urgency: ${topAction.urgency}/10)
- What needs attention: ${topAction.intent}
- Deal value: ${topAction.dollarValue > 0 ? `${topAction.dollarValue.toLocaleString()}` : 'unknown'}

RULES:
- Address user as "vy" (you). Never "uživatel".
- subject: concise, conveys urgency
- header: short header for the email
- body: one sentence describing what needs immediate attention

CRITICAL LANGUAGE REQUIREMENT:
You MUST write ALL output in ${lang}. Every word, including the subject line, must be in ${lang}.
${lang === 'Czech' ? 'Czech is a West Slavic language written in Latin script — it is NOT Russian, Ukrainian, or any other Cyrillic-script language. Do not confuse Slavic languages. "Urgent" in Czech is "Naléhavé", not "Срочно".' : ''}
Do NOT mix languages. Do NOT use words from other languages.

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
    : `Write a professional email in ${settings.ai_language || 'Czech'}.\nSign off with:\n${settings.ai_email_signature}`

  const prompt = `${systemContext}

You are an executive assistant writing a ${isWhatsApp ? 'WhatsApp message' : 'email'} on behalf of your boss.
Language: ${settings.ai_language || 'Czech'}.

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
 * Stage: drafting (claude-sonnet → gemini-2.5-flash)
 *
 * The AI receives full conversation context and writes an appropriate message.
 * "reschedule" = the meeting is shifted to a new time (NOT cancelled).
 * "cancel" = the meeting is deleted entirely.
 */
export async function generateConflictResolutionDraft(
  resolutionType: 'reschedule' | 'cancel',
  existingEventTitle: string,
  existingEventTime: string,
  newTime: string | null,
  cpName: string,
  dealContext: string | null,
  settings: UserSettings,
  conversationContext?: unknown
): Promise<{ subject: string; body: string }> {
  console.log(`[AI:generateConflictResolutionDraft] ${resolutionType} for "${existingEventTitle}" → ${cpName}`)
  const systemContext = getAISystemPrompt(settings)

  // Determine the nature of the change for the AI
  let changeDescription: string
  if (resolutionType === 'reschedule') {
    if (newTime) {
      // Check if same day by comparing date portions
      const origDate = existingEventTime.split(',')[0]?.trim()
      const newDate = newTime.split(',')[0]?.trim()
      const sameDay = origDate && newDate && origDate === newDate
      changeDescription = sameDay
        ? `The meeting is being SHIFTED on the same day: from ${existingEventTime} to ${newTime}. This is a minor time adjustment, not a cancellation or major reschedule.`
        : `The meeting is being RESCHEDULED: from ${existingEventTime} to ${newTime}. The meeting is NOT cancelled — it's moving to a different time.`
    } else {
      changeDescription = `The meeting originally at ${existingEventTime} needs to be rescheduled. A new time has not been determined yet. The meeting is NOT cancelled — ask the counterparty for their availability.`
    }
  } else {
    changeDescription = `The meeting "${existingEventTitle}" at ${existingEventTime} is being CANCELLED. It will not take place. If appropriate, mention willingness to reschedule.`
  }

  const prompt = `${systemContext}

You are an executive assistant writing an email on behalf of your boss to ${cpName}.

TONE: ${settings.ai_tone_cp}
Language: ${settings.ai_language || 'Czech'}.

SITUATION:
${changeDescription}

EVENT DETAILS:
- Event: ${existingEventTitle}
- Original time: ${existingEventTime}
${resolutionType === 'reschedule' && newTime ? `- New time: ${newTime}` : ''}
- Counterparty: ${cpName}

${dealContext ? `DEAL CONTEXT (use this to understand what this meeting is about):\n${dealContext}\n` : ''}
${conversationContext ? `CONVERSATION HISTORY (use this to understand your relationship with ${cpName}, the tone of previous exchanges, and what the meeting is about — write accordingly):\n${JSON.stringify(conversationContext, null, 2)}\n` : ''}

RULES:
- Write a natural, human email appropriate to the situation and relationship.
- Match the weight of the email to the size of the change:
  * A 15-30 minute shift on the same day → 2-3 sentences, casual, no drama
  * A different-day reschedule → brief apology + new time + reason if natural
  * A cancellation → polite, brief, offer to reschedule if the deal context suggests it
- Output ONLY in ${settings.ai_language || 'Czech'} using Latin script. Plain text only.
- Sign off with: ${settings.ai_email_signature}
${resolutionType === 'reschedule'
    ? `- The meeting is NOT cancelled. NEVER use words like "zrušena", "zrušit", "cancelled", "cancel", "nebude se konat". Use "přesunout", "posunout", "změna času" instead.`
    : ''}
- Do NOT over-apologize. Do NOT use phrases like "s lítostí Vás informuji" for a minor time shift.

Respond with ONLY valid JSON:
{
  "subject": "Email subject line",
  "body": "Email body text (ready to send)"
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return resolutionType === 'reschedule'
      ? { subject: `Přesunutí schůzky: ${existingEventTitle}`, body: `Dobrý den,\n\nomlouvám se, ale potřebuji přesunout naši schůzku "${existingEventTitle}"${newTime ? ` na ${newTime}` : ''}.\n\nDěkuji za pochopení.\n\n${settings.ai_email_signature}` }
      : { subject: `Zrušení schůzky: ${existingEventTitle}`, body: `Dobrý den,\n\nomlouvám se, ale musím zrušit naši schůzku "${existingEventTitle}".\n\nDěkuji za pochopení.\n\n${settings.ai_email_signature}` }
  }
  return JSON.parse(jsonMatch[0])
}

/**
 * Generate a brief headline + story for an action card.
 * Used in the new headline-style email template and web brief page.
 * Stage: drafting (claude-sonnet → gemini-2.5-flash)
 */
export async function generateBriefHeadline(
  action: {
    actionType: string
    cpName: string
    dealValue: number
    urgency: number
    urgencyJustification?: string
    intent: string
    daysSinceContact: number
    holdSlotText?: string | null
  },
  dealContext: {
    currentState?: string
    risks?: string[]
    dealType?: string | null
  } | null,
  calendar: { time: string; title: string }[],
  settings: UserSettings
): Promise<{ headline: string; story: string }> {
  const calendarText = calendar.length > 0
    ? calendar.map(e => `${e.time}: ${e.title}`).join('\n')
    : 'No meetings today'

  const prompt = `You are Mila, a sharp executive assistant. Write a brief headline and 2-3 sentence story for ONE action card.

TONE: ${settings.ai_tone_user}

ACTION:
- Type: ${action.actionType}
- Counterparty: ${action.cpName}
- Deal value: ${action.dealValue > 0 ? `${action.dealValue.toLocaleString()} ${settings.typical_deal_size_currency}` : 'unknown'}
- Urgency: ${action.urgency}/10${action.urgencyJustification ? ` — ${action.urgencyJustification}` : ''}
- What Mila proposes: ${action.intent}
- Days since CP last contacted: ${action.daysSinceContact}
${action.holdSlotText ? `- Mila booked a slot: ${action.holdSlotText}` : ''}

DEAL CONTEXT:
${dealContext?.currentState ? `- Current state: ${dealContext.currentState}` : '- No deal context available'}
${dealContext?.risks?.length ? `- Risks: ${dealContext.risks.join(', ')}` : ''}
${dealContext?.dealType ? `- Deal type: ${dealContext.dealType}` : ''}

USER'S SCHEDULE TODAY:
${calendarText}

RULES:
- Output in ${settings.ai_language || 'Czech'}. Plain text only. No markdown, no bullet points.
- Address user as "vy" (you). Never "uživatel".
- headline: Bold, direct. Like a newspaper headline. Max 10 words. Name the CP. Convey the urgency through words — no labels like "REPLY" or "SCHEDULE". Examples: "Novotný POTŘEBUJE odpověď do poledne", "Zavolejte Evě do 10".
- story: 2-3 sentences. What's at stake, what Mila already did, what user needs to do. Reference the user's schedule if relevant ("než dojedete na schůzku v 14:00"). Be a human assistant, not a system notification.
- Urgency 9-10: Lead with consequence. What will the user LOSE if they don't act NOW.
- Urgency 7-8: Clear time pressure. Name the deadline.
- Urgency 1-6: Professional, calm. State the facts.
- Do NOT include the action type label. Weave it into the language naturally.
- Do NOT repeat slot times — the card template renders those separately.

Respond with ONLY valid JSON:
{
  "headline": "...",
  "story": "..."
}`

  const text = await runAITask('drafting', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    // Fallback: use intent as story, CP name as headline
    return {
      headline: action.cpName,
      story: action.intent,
    }
  }
  return JSON.parse(jsonMatch[0])
}

/**
 * Regenerate a draft incorporating user instruction.
 * Used when user types free-text edits in the web brief card.
 * Stage: draft_edit (claude-haiku → claude-sonnet)
 */
export async function regenerateDraftWithInstruction(
  currentDraft: { subject: string; body: string },
  instruction: string,
  conversationContext: unknown,
  cpName: string,
  channel: 'email' | 'whatsapp',
  settings: UserSettings
): Promise<{ subject: string; body: string }> {
  const systemContext = getAISystemPrompt(settings)
  const isWhatsApp = channel === 'whatsapp'

  const prompt = `${systemContext}

You are refining a draft ${isWhatsApp ? 'WhatsApp message' : 'email'} based on user instructions.
Language: ${settings.ai_language || 'Czech'}.

CURRENT DRAFT:
Subject: ${currentDraft.subject}
Body: ${currentDraft.body}

USER'S INSTRUCTION:
${instruction}

CONVERSATION CONTEXT:
${JSON.stringify(conversationContext, null, 2)}

RECIPIENT: ${cpName}

RULES:
- Apply the user's instruction to the current draft.
- Keep the tone consistent: ${isWhatsApp ? 'short, conversational WhatsApp style' : settings.ai_tone_cp}.
- If the instruction contradicts the draft, the instruction wins.
- If the instruction is a small tweak, change only what's needed.
- If the instruction says "zrušit" or "cancel", return empty subject and body.
- Output ONLY in ${settings.ai_language || 'Czech'}.
${!isWhatsApp ? `- Keep the signature: ${settings.ai_email_signature}` : ''}

Respond with ONLY valid JSON:
{
  "subject": "${isWhatsApp ? '(empty string for WhatsApp)' : 'Updated subject'}",
  "body": "Updated body text"
}`

  const text = await runAITask('draft_edit', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return currentDraft
  }
  return JSON.parse(jsonMatch[0])
}
