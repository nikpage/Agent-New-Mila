import type { ConversationSummary, ActionType, UserSettings } from '../supabase/types'
import { runAITask } from './runner'
import { getAISystemPrompt } from '@/config/client'

/**
 * Pre-filter: Quick spam/junk detection using cheapest model.
 * Returns { relevant: true/false }. Gate before full classification.
 */
export async function preFilterEmail(
  subject: string,
  body: string,
  from: string
): Promise<{ relevant: boolean }> {
  const prompt = `Is this email from a real person requiring human attention? Answer ONLY with valid JSON: {"relevant": true} or {"relevant": false}

Relevant: Business inquiry, question, meeting proposal, follow-up, negotiation, personal message, deal-related.
NOT relevant: Newsletter, automated notification, marketing, social media alert, system notification, spam, promotional, transactional receipt.

FROM: ${from}
SUBJECT: ${subject}
BODY: ${body.slice(0, 500)}`

  const text = await runAITask('preFilter', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { relevant: false }
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return { relevant: false }
  }
}

export async function analyzeConversation(
  messages: { direction: string; text: string; date: Date }[]
): Promise<ConversationSummary> {
  const messageText = messages
    .map(m => `[${m.direction}] ${m.date.toISOString().split('T')[0]}: ${m.text}`)
    .join('\n\n')

  const prompt = `Analyze this email conversation and provide a JSON summary.

CONVERSATION:
${messageText}

Respond with ONLY valid JSON in this exact format:
{
  "currentState": "Brief description of where this conversation/deal currently stands (in Czech)",
  "risks": ["Risk 1 (in Czech)", "Risk 2 (in Czech)"],
  "nextSteps": ["Next step 1 (in Czech)", "Next step 2 (in Czech)"],
  "keyPoints": ["Key point 1 (in Czech)", "Key point 2 (in Czech)"]
}

Be concise. Focus on actionable insights.`

  const text = await runAITask('analysis', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse conversation analysis')

  return JSON.parse(jsonMatch[0]) as ConversationSummary
}

/**
 * Determine what action should be proposed (Intent Only - NO DRAFTS)
 */
export async function proposeAction(
  conversationSummary: ConversationSummary,
  recentMessages: { direction: string; text: string }[],
  cpName: string | null,
  settings: UserSettings,
  channel: 'email' | 'whatsapp' = 'email'
): Promise<{
  actionType: ActionType
  rationale_cs: string
  intent_cs: string
  missingInfo: { label: string; value: null }[]
  urgency: number
  dollarValue: number
  painFactor: number
  suggestedLocation?: string | null
  suggestedTime?: string | null
}> {
  const recentText = recentMessages
    .slice(-3)
    .map(m => `[${m.direction}]: ${m.text.slice(0, 500)}`)
    .join('\n\n')

  const systemContext = getAISystemPrompt(settings)
  const channelNote = channel === 'whatsapp'
    ? 'CHANNEL: WhatsApp — keep messages short, informal, no subject line needed.'
    : 'CHANNEL: Email — standard professional format.'

  const prompt = `${systemContext}

${channelNote}

You are Mila, a proactive executive assistant. Based on this conversation, determine what action to take.

CONVERSATION STATE:
${JSON.stringify(conversationSummary, null, 2)}

RECENT MESSAGES:
${recentText}

COUNTERPARTY: ${cpName || 'Unknown'}

CRITICAL - ACTION TYPE RULES:
1. Use SCHEDULE (NOT REPLY) whenever the conversation involves ANY of: meeting, schůzka, prohlídka, viewing, visit, setkání, oběd, lunch, návštěva, proposed time, confirmation of time, "sejít se", "potkat se", "zajít", appointment, termín, "přijít se podívat", "kdy se můžeme sejít", "přijedu", "uvidíme se".
2. If the user (outbound message) proposed or suggested a meeting → use SCHEDULE.
3. If the counterparty proposed a specific time → use SCHEDULE and fill suggestedTime.
4. If the conversation implies any need for a physical meeting, even indirectly → use SCHEDULE.
5. REPLY is ONLY for pure email responses with NO scheduling component whatsoever.

CRITICAL - PROACTIVE INTENT RULES:
intent_cs must describe what Mila HAS ALREADY DONE and what she WILL DO when user clicks UDĚLAT. Be maximally specific and concrete.

GOOD examples:
- "Zkontrolovala jsem kalendář a připravím odpověď ${cpName || 'protistraně'}: zodpovím otázku o parkování a nabídnu 3 termíny prohlídky. Klikněte UDĚLAT a odešlu email."
- "Připravím potvrzení schůzky s ${cpName || 'protistranou'} na středu v 9:30 a zablokuji čas ve vašem kalendáři. Klikněte UDĚLAT."
- "Připravím odpověď: zodpovím dotazy ohledně plochy bytu a stavu rekonstrukce, nabídnu termíny prohlídky příští týden. Klikněte UDĚLAT a odešlu email."

BAD examples (NEVER write like this):
- "Navrhuji odpovědět a buď potvrdit, nebo navrhnout jiný termín" (too vague)
- "Navrhuji se zeptat na více podrobností" (vague, no concrete action)
- "Navrhuji odpovědět na dotazy" (no specifics)

Respond with ONLY valid JSON:
{
  "actionType": "REPLY" | "SCHEDULE" | "WAIT" | "FILE",
  "rationale_cs": "One sentence in CZECH explaining WHY this action is needed now.",
  "intent_cs": "PROACTIVE description in CZECH: what Mila HAS DONE + what she WILL DO on UDĚLAT. Include specific data points from conversation. Return null if WAIT/FILE.",
  "missingInfo": [{"label": "FULL question in Czech (e.g. 'Kolik má byt metrů čtverečních?')", "value": null}],
  "urgency": 1-10 (10 = needs immediate attention),
  "dollarValue": estimated deal value in dollars (0 if unknown),
  "painFactor": 1-10 (how much pain from ignoring this),
  "suggestedLocation": "Physical meeting location if mentioned or clearly implied. null if not specified.",
  "suggestedTime": "ISO 8601 datetime if counterparty or user proposed a specific time (e.g. '2025-02-12T09:30:00'). null if no specific time mentioned."
}

Rules:
- DO NOT write the email draft.
- For SCHEDULE: intent_cs should say Mila will check calendar and prepare time slots.
- missingInfo: Extract ALL specific questions the counterparty asked. The label MUST be the COMPLETE question in Czech. Do NOT shorten to keywords. Examples: "Je tam sklep nebo komora?" not "Sklep/Komora".`

  const text = await runAITask('planning', prompt)

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse action proposal')

  return JSON.parse(jsonMatch[0])
}

/**
 * Generate the Final Draft (Just-In-Time)
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

// ... (Keep extractTopic, shouldJoinConversation, generateBriefHeadline, classifyEmail - they are fine) ...
export async function extractTopic(messages: { text: string }[]): Promise<string> {
  const messageTexts = messages.slice(0, 5).map(m => m.text.slice(0, 300)).join('\n---\n')
  const prompt = `What is the main topic of this email conversation? Respond with ONLY a brief topic (3-7 words) in CZECH.\n\n${messageTexts}`
  const text = await runAITask('threading', prompt)
  return text.trim()
}

export async function shouldJoinConversation(
  newMessage: { subject: string; body: string; from: string },
  existingConversation: { topic: string; summary: string; participants: string[] }
): Promise<boolean> {
  const prompt = `Does this new email belong to the existing conversation?\n\nNEW EMAIL:\nFrom: ${newMessage.from}\nSubject: ${newMessage.subject}\nBody preview: ${newMessage.body.slice(0, 500)}\n\nEXISTING CONVERSATION:\nTopic: ${existingConversation.topic}\nSummary: ${existingConversation.summary}\nParticipants: ${existingConversation.participants.join(', ')}\n\nRespond with ONLY "yes" or "no".`
  const text = await runAITask('threading', prompt)
  const answer = text.toLowerCase().trim()
  return answer === 'yes' || answer.includes('yes')
}

export async function generateBriefHeadline(
  todayEvents: { title: string; time: string }[],
  pendingActions: { type: string; cpName: string; urgency: number }[],
  tomorrowHighlights?: string[]
): Promise<string> {
  const eventsText = todayEvents.length > 0 ? todayEvents.map(e => `${e.time}: ${e.title}`).join('\n') : 'No meetings scheduled'
  const actionsText = pendingActions.sort((a, b) => b.urgency - a.urgency).slice(0, 5).map(a => `${a.type} for ${a.cpName} (urgency: ${a.urgency})`).join('\n')
  const prompt = `Write a brief, personal executive assistant-style morning briefing headline (2-3 sentences) in CZECH.\n\nTODAY'S SCHEDULE:\n${eventsText}\n\nPENDING ACTIONS:\n${actionsText}\n\n${tomorrowHighlights ? `TOMORROW: ${tomorrowHighlights.join(', ')}` : ''}\n\nWrite as if you're a thoughtful executive assistant giving a quick morning status. Be warm but professional. Focus on what matters most today.`
  const text = await runAITask('drafting', prompt)
  return text.trim()
}

export async function classifyEmail(
  subject: string,
  body: string,
  from: string
): Promise<{
  isActionable: boolean
  category: 'meeting_request' | 'question' | 'update' | 'confirmation' | 'newsletter' | 'spam' | 'other'
  priority: 'high' | 'medium' | 'low'
}> {
  const prompt = `Classify this email.\n\nFROM: ${from}\nSUBJECT: ${subject}\nBODY: ${body.slice(0, 1000)}\n\nRespond with ONLY valid JSON:\n{\n  "isActionable": true/false (does this require user action?),\n  "category": "meeting_request" | "question" | "update" | "confirmation" | "newsletter" | "spam" | "other",\n  "priority": "high" | "medium" | "low"\n}\n\nNewsletters, automated emails, and spam are NOT actionable.`
  const text = await runAITask('classify', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { isActionable: false, category: 'other', priority: 'low' }
  return JSON.parse(jsonMatch[0])
}
