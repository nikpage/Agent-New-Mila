import type { ConversationSummary, ActionType, DealType, UserSettings } from '../supabase/types'
import { runAITask } from './runner'
import { getAISystemPrompt, containsHighValueSignals } from '@/config/client'

/**
 * Filter: Quick spam/junk detection using cheapest model.
 * Returns { relevant: true/false }. Gate before full classification.
 * Stage: filter (gemini-2.5-flash-lite → claude-haiku)
 */
export async function filterEmail(
  subject: string,
  body: string,
  from: string
): Promise<{ relevant: boolean }> {
  console.log(`[AI:filterEmail] Running stage 'filter'`)
  const prompt = `Is this email from a real person requiring human attention? Answer ONLY with valid JSON: {"relevant": true} or {"relevant": false}

Relevant: Business inquiry, question, meeting proposal, follow-up, negotiation, personal message, deal-related.
NOT relevant: Newsletter, automated notification, marketing, social media alert, system notification, spam, promotional, transactional receipt.

FROM: ${from}
SUBJECT: ${subject}
BODY: ${body.slice(0, 500)}`

  const text = await runAITask('filter', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { relevant: false }
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return { relevant: false }
  }
}

/**
 * Enrich a single message: extract key information as structured free-text.
 * Stage: enrichment (gemini-2.5-flash-lite → gemini-2.5-flash)
 * Runs per-message after cleaning, before threading. Cost-sensitive — uses cheapest model.
 *
 * Accepts optional UserSettings for business context and language.
 * When settings are provided, output is in the user's configured language
 * and domain-specific terms are interpreted correctly.
 */
export async function enrichMessage(
  cleanedText: string,
  channel: 'email' | 'whatsapp',
  direction: 'inbound' | 'outbound',
  conversationContext?: string,
  settings?: UserSettings
): Promise<string> {
  console.log(`[AI:enrichMessage] Running stage 'enrichment' (${channel}/${direction})`)
  const contextBlock = conversationContext
    ? `\nRECENT CONVERSATION CONTEXT:\n${conversationContext}\n`
    : ''

  const businessContext = settings
    ? `BUSINESS CONTEXT: ${settings.client_company} — ${settings.business_specialization}. Market: ${settings.business_market}.\n`
    : ''

  const directionLabel = direction === 'outbound'
    ? 'sent BY the email account owner'
    : 'received FROM a counterparty'

  const prompt = `${businessContext}Extract key information from this message. Output in CZECH. Only include what's actually present. Do not invent or guess. Leave out anything not clearly supported by the text. Interpret terms in context of the business domain above — do NOT translate domain-specific words literally.

VOICE: Refer to the email account owner as "vy" (you), never as "uživatel" (the user). The counterparty is referred to by name or as "protistrana".
FORMATTING: Plain text only. No markdown, no ** bold **, no # headers.

- Who's involved (all parties mentioned)
- What property, subject matter, or topic
- Message type (meeting request, question, offer, info, personal, admin, legal, update...)
- If deal-related: stage, key numbers (price, area, dates), commitments made
- If personal/admin: what it's about, any time sensitivity, any action needed
- Core intent (what this message actually says or asks)
- Urgency signals: deadlines, time pressure, explicit urgency language, consequences of delay (e.g. "do zítra", "ASAP", "jinak odstoupím", "deadline pátek"). Omit if none present

Channel: ${channel}
Direction: ${direction} (${directionLabel})
${contextBlock}
MESSAGE:
${cleanedText.slice(0, 3000)}

Respond with ONLY the extracted information as concise structured text in CZECH. No JSON. No markdown headers. Just the facts.`

  return (await runAITask('enrichment', prompt)).trim()
}

/**
 * Analyze a conversation for summary, risks, next steps.
 * Stage: analysis (gemini-2.5-flash → claude-sonnet)
 *
 * Accepts optional UserSettings for business context, language, and user identity.
 * When settings are provided, the AI knows who [outbound] and [inbound] represent.
 */
export async function analyzeConversation(
  messages: { direction: string; text: string; date: Date }[],
  settings?: UserSettings
): Promise<ConversationSummary> {
  console.log(`[AI:analyzeConversation] Running stage 'analysis'`)
  const messageText = messages
    .map(m => `[${m.direction}] ${m.date.toISOString().split('T')[0]}: ${m.text}`)
    .join('\n\n')

  const businessContext = settings
    ? `${getAISystemPrompt(settings)}\n\n`
    : ''

  const prompt = `${businessContext}Analyze this conversation and provide a JSON summary. All text field values MUST be in CZECH.

CRITICAL — ROLE IDENTIFICATION:
- Messages marked [outbound] are sent BY THE EMAIL ACCOUNT OWNER (your boss, the user you work for). Always the user, never the counterparty.
- Messages marked [inbound] are FROM THE COUNTERPARTY (external contact).
- NEVER confuse who is who.

CRITICAL — VOICE AND PERSPECTIVE:
- You are Mila, the user's assistant. Address the user directly as "vy" (you).
- NEVER refer to the user in 3rd person. NEVER write "uživatel" (the user). Write "vy" (you).
- Example GOOD: "Čekáte na odpověď od protistrany" (You are waiting for a response)
- Example BAD: "Uživatel čeká na odpověď" (The user is waiting)

CRITICAL — FORMATTING:
- Output PLAIN TEXT only. No markdown. No ** bold **. No * italic *. No # headers. No bullet markers.
- Use commas and periods for structure, not formatting symbols.

CONVERSATION:
${messageText}

Respond with ONLY valid JSON in this exact format:
{
  "currentState": "Brief description of where this conversation/deal currently stands (in Czech, addressing user as vy)",
  "risks": ["Risk 1 (in Czech)", "Risk 2 (in Czech)"],
  "nextSteps": ["Next step 1 (in Czech)", "Next step 2 (in Czech)"],
  "keyPoints": ["Key point 1 (in Czech)", "Key point 2 (in Czech)"],
  "confidence": 0.75,
  "confidenceReason": "Why you are this confident (in Czech)",
  "dealType": "sale"
}

FIELD RULES:
- confidence: 0.0 to 1.0 — how confident you are in the summary's accuracy. Consider: message count, message clarity, how much context is available, whether the conversation is coherent.
- confidenceReason: Explain WHY this confidence level — what evidence supports or limits your understanding. NOT how the analysis was done.
- dealType: one of "sale", "purchase", "rental", "lease", "consultation", "other", or null if not a deal/transaction.

Be concise. Focus on actionable insights.`

  const text = await runAITask('analysis', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse conversation analysis')

  const parsed = JSON.parse(jsonMatch[0])
  return {
    currentState: parsed.currentState || '',
    risks: parsed.risks || [],
    nextSteps: parsed.nextSteps || [],
    keyPoints: parsed.keyPoints || [],
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
    confidenceReason: typeof parsed.confidenceReason === 'string' ? parsed.confidenceReason : null,
    dealType: typeof parsed.dealType === 'string' ? parsed.dealType : null,
  } satisfies ConversationSummary
}

/**
 * Determine what action should be proposed (Intent Only - NO DRAFTS)
 * Stage: planning (gemini-2.5-flash → claude-sonnet)
 */
export type ProposedAction = {
  actionType: ActionType
  rationale_cs: string
  intent_cs: string
  missingInfo: { label: string; value: null }[]
  urgency: number
  dollarValue: number
  weight: number
  dealType: DealType
  suggestedLocation?: string | null
  suggestedTime?: string | null
}

export async function proposeAction(
  conversationSummary: ConversationSummary,
  recentMessages: { direction: string; text: string }[],
  cpName: string | null,
  settings: UserSettings,
  channel: 'email' | 'whatsapp' = 'email',
  classificationPriority: 'high' | 'medium' | 'low' | null = null
): Promise<ProposedAction> {
  console.log(`[AI:proposeAction] Running stage 'planning' for ${cpName || 'unknown CP'}`)
  const recentText = recentMessages
    .slice(-3)
    .map(m => `[${m.direction}]: ${m.text.slice(0, 500)}`)
    .join('\n\n')

  const systemContext = getAISystemPrompt(settings)
  const channelNote = channel === 'whatsapp'
    ? 'CHANNEL: WhatsApp — keep messages short, informal, no subject line needed.'
    : 'CHANNEL: Email — standard professional format.'

  // Check if conversation contains high-value signals
  const conversationText = recentMessages.map(m => m.text).join(' ')
  const isHighValue = containsHighValueSignals(conversationText, settings)
  const highValueNote = isHighValue
    ? 'HIGH-VALUE DEAL DETECTED — this conversation matches high-value signals. Prioritize accordingly and estimate dollar value carefully.'
    : ''

  const classificationNote = classificationPriority
    ? `EMAIL CLASSIFICATION PRIORITY: ${classificationPriority.toUpperCase()} — this was pre-classified as ${classificationPriority} priority during ingestion. Use this as a starting anchor for your urgency assessment.`
    : ''

  const prompt = `${systemContext}

${channelNote}
${highValueNote}
${classificationNote}

You are Mila, a proactive executive assistant. Based on this conversation, determine what action to take.

CRITICAL — ROLE IDENTIFICATION:
- Messages marked [outbound] are sent BY YOUR BOSS (the email account owner, the user you work for). Your boss is ALWAYS the principal — the client, the buyer, the decision-maker on our side.
- Messages marked [inbound] are FROM THE COUNTERPARTY (${cpName || 'the other party'}). They are the service provider, seller, agent, or external party.
- NEVER confuse who is who. Your boss wrote the [outbound] messages. The counterparty wrote the [inbound] messages.
- When describing actions, refer to your boss's actions as "you" and the counterparty by name.

CONVERSATION STATE:
${JSON.stringify(conversationSummary, null, 2)}

RECENT MESSAGES:
${recentText}

COUNTERPARTY: ${cpName || 'Unknown'}

CRITICAL - ACTION TYPE RULES (pick ONE per conversation):
1. SCHEDULE — use whenever the conversation involves ANY of: meeting, schůzka, prohlídka, viewing, visit, setkání, oběd, lunch, návštěva, proposed time, confirmation of time, "sejít se", "potkat se", "zajít", appointment, termín, "přijít se podívat", "kdy se můžeme sejít", "přijedu", "uvidíme se". SCHEDULE takes priority over REPLY if any scheduling is involved.
2. If the user (outbound message) proposed or suggested a meeting → use SCHEDULE.
3. If the counterparty proposed a specific time → use SCHEDULE and fill suggestedTime.
4. If the conversation implies any need for a physical meeting, even indirectly → use SCHEDULE.
5. REPLY — pure email/message response with NO scheduling component whatsoever.
6. TODO — something the user needs to do themselves (call lawyer, write proposal, plan photoshoot, prepare documents). Mila doesn't draft anything — she just describes what needs doing in intent_cs.
7. You MUST always return one of REPLY, SCHEDULE, or TODO. Every inbound message deserves a response. Never skip.
8. If the conversation needs both a reply AND scheduling, use SCHEDULE. Include the reply content (answering CP's questions) in the intent_cs alongside the scheduling plan.

CRITICAL - VOICE AND PERSPECTIVE:
- You are Mila, the user's assistant. Address the user directly as "vy" (you).
- NEVER refer to the user in 3rd person. NEVER write "uživatel" (the user). Write "vy" (you).
- Example GOOD: "Zkontrolovala jsem váš kalendář" (I checked your calendar)
- Example BAD: "Uživatel nahrál pas" (The user uploaded a passport)

CRITICAL - FORMATTING:
- Output PLAIN TEXT only. No markdown. No ** bold **. No * italic *. No # headers.

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

Respond with ONLY valid JSON — a single object:
{
  "actionType": "REPLY" | "SCHEDULE" | "TODO",
  "rationale_cs": "One sentence in CZECH explaining WHY this action is needed now.",
  "intent_cs": "PROACTIVE description in CZECH: what Mila HAS DONE + what she WILL DO on UDĚLAT. Include specific data points from conversation. For TODO: describe what the user needs to do themselves. Return null if WAIT/ARCHIVE.",
  "missingInfo": [{"label": "FULL question in Czech (e.g. 'Kolik má byt metrů čtverečních?')", "value": null}],
  "urgency": 1-10 (calibration: 1-3 = routine, no time pressure; 4-6 = should respond within days, mild sensitivity; 7-8 = explicit deadline, significant value at risk, CP waiting; 9 = tomorrow AT LATEST; 10 = less than 1 hour),
  "dollarValue": estimated deal value in ${settings.typical_deal_size_currency} (0 if unknown, use range ${settings.typical_deal_size_min.toLocaleString()}-${settings.typical_deal_size_max.toLocaleString()} as reference),
  "weight": 1-10 (how immovable is this? 1 = easy to reschedule, 10 = hard to move. Use 100 ONLY for absolutely immovable commitments like court dates, kids events, airport pickups),
  "dealType": "sale" | "purchase" | "rental" | "lease" | "consultation" | "other" | null (classify the nature of this deal/conversation),
  "suggestedLocation": "Physical meeting location if mentioned or clearly implied. null if not specified.",
  "suggestedTime": "ISO 8601 datetime if counterparty or user proposed a specific time (e.g. '2025-02-12T09:30:00'). null if no specific time mentioned."
}

Rules:
- DO NOT write the email draft.
- For SCHEDULE: intent_cs should describe the full plan — answering CP's questions AND scheduling the meeting. missingInfo should be empty (scheduling handles it).
- For REPLY: intent_cs should describe the email content Mila will prepare. missingInfo should contain questions CP asked.
- For TODO: intent_cs should describe what the user needs to do. No draft needed.
- missingInfo: Extract ALL specific questions the counterparty asked. The label MUST be the COMPLETE question in Czech. Do NOT shorten to keywords. Examples: "Je tam sklep nebo komora?" not "Sklep/Komora".`

  const text = await runAITask('planning', prompt)

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse action proposal')

  return JSON.parse(jsonMatch[0])
}

/**
 * Generate the Final Draft (Just-In-Time)
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

/**
 * Extract the topic of a conversation.
 * Stage: threading (gemini-2.5-flash → claude-sonnet)
 */
export async function extractTopic(messages: { text: string }[]): Promise<string> {
  console.log(`[AI:extractTopic] Running stage 'threading'`)
  const messageTexts = messages.slice(0, 5).map(m => m.text.slice(0, 300)).join('\n---\n')
  const prompt = `What is the main topic of this email conversation? Respond with ONLY a brief topic (3-7 words) in CZECH.\n\n${messageTexts}`
  const text = await runAITask('threading', prompt)
  return text.trim()
}

/**
 * Decide whether a new message belongs to an existing conversation.
 * Stage: threading (gemini-2.5-flash → claude-sonnet)
 */
export async function shouldJoinConversation(
  newMessage: { subject: string; body: string; from: string },
  existingConversation: { topic: string; summary: string; participants: string[] }
): Promise<boolean> {
  console.log(`[AI:shouldJoinConversation] Running stage 'threading'`)
  const prompt = `Does this new email belong to the existing conversation?\n\nNEW EMAIL:\nFrom: ${newMessage.from}\nSubject: ${newMessage.subject}\nBody preview: ${newMessage.body.slice(0, 500)}\n\nEXISTING CONVERSATION:\nTopic: ${existingConversation.topic}\nSummary: ${existingConversation.summary}\nParticipants: ${existingConversation.participants.join(', ')}\n\nRespond with ONLY "yes" or "no".`
  const text = await runAITask('threading', prompt)
  const answer = text.toLowerCase().trim()
  return answer === 'yes' || answer.includes('yes')
}

/**
 * Generate a morning brief headline.
 * Stage: drafting (gemini-2.5-flash → claude-sonnet)
 */
export async function generateBriefHeadline(
  todayEvents: { title: string; time: string }[],
  pendingActions: { type: string; cpName: string; urgency: number }[],
  tomorrowHighlights?: string[]
): Promise<string> {
  console.log(`[AI:generateBriefHeadline] Running stage 'drafting'`)
  const eventsText = todayEvents.length > 0 ? todayEvents.map(e => `${e.time}: ${e.title}`).join('\n') : 'No meetings scheduled'
  const actionsText = pendingActions.sort((a, b) => b.urgency - a.urgency).slice(0, 5).map(a => `${a.type} for ${a.cpName} (urgency: ${a.urgency})`).join('\n')
  const prompt = `Write a brief, personal executive assistant-style morning briefing headline (2-3 sentences) in CZECH. Address the user directly as "vy" (you). NEVER use "uživatel" (the user). No markdown, no ** bold **, no # headers. Plain text only.\n\nTODAY'S SCHEDULE:\n${eventsText}\n\nPENDING ACTIONS:\n${actionsText}\n\n${tomorrowHighlights ? `TOMORROW: ${tomorrowHighlights.join(', ')}` : ''}\n\nWrite as if you're a thoughtful executive assistant giving a quick morning status. Be warm but professional. Focus on what matters most today.`
  const text = await runAITask('drafting', prompt)
  return text.trim()
}

/**
 * Classify an email into category + priority.
 * Stage: classify (gemini-2.5-flash-lite → claude-haiku)
 */
export async function classifyEmail(
  subject: string,
  body: string,
  from: string
): Promise<{
  isActionable: boolean
  category: 'meeting_request' | 'question' | 'update' | 'confirmation' | 'newsletter' | 'spam' | 'other'
  priority: 'high' | 'medium' | 'low'
}> {
  console.log(`[AI:classifyEmail] Running stage 'classify'`)
  const prompt = `Classify this email.\n\nFROM: ${from}\nSUBJECT: ${subject}\nBODY: ${body.slice(0, 1000)}\n\nRespond with ONLY valid JSON:\n{\n  "isActionable": true/false (does this require user action?),\n  "category": "meeting_request" | "question" | "update" | "confirmation" | "newsletter" | "spam" | "other",\n  "priority": "high" | "medium" | "low"\n}\n\nNewsletters, automated emails, and spam are NOT actionable.`
  const text = await runAITask('classify', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { isActionable: false, category: 'other', priority: 'low' }
  try {
    return JSON.parse(jsonMatch[0])
  } catch {
    return { isActionable: false, category: 'other', priority: 'low' }
  }
}
