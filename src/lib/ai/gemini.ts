import type { ConversationSummary, ActionType, DealType, UserSettings } from '../supabase/types'
import { runAITask } from './runner'
import { getAISystemPrompt, containsHighValueSignals } from '@/config/client'

/**
 * Pre-filter: Quick spam/junk detection using cheapest model.
 * Returns { relevant: true/false }. Gate before full classification.
 * Stage: preFilter (gemini-2.5-flash-lite → claude-haiku)
 */
export async function preFilterEmail(
  subject: string,
  body: string,
  from: string
): Promise<{ relevant: boolean }> {
  console.log(`[AI:preFilterEmail] Running stage 'preFilter'`)
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
  const language = settings?.ai_language === 'cs' ? 'Czech' : (settings?.ai_language || 'Czech')

  const prompt = `${businessContext}Extract key information from this message. Output in ${language}. Use the following as guidance for what to look for, but only include what's actually present. Do not invent or guess. Leave out anything not clearly supported by the text. Interpret terms in context of the business domain above — do NOT translate domain-specific words literally.

- Kdo je zapojen (všechny zmíněné strany)
- Jaký předmět, téma nebo nemovitost
- Typ zprávy (žádost o schůzku, dotaz, nabídka, info, osobní, admin, právní, update...)
- Pokud jde o obchod: fáze, klíčová čísla (cena, plocha, termíny), závazky
- Pokud osobní/admin: o co jde, časová citlivost, potřebná akce
- Co zpráva skutečně říká nebo žádá (hlavní záměr)

Channel: ${channel}
Direction: ${direction} (${direction === 'outbound' ? 'sent BY the email account owner' : 'received FROM a counterparty'})
${contextBlock}
MESSAGE:
${cleanedText.slice(0, 3000)}

Respond with ONLY the extracted information as concise structured text in ${language}. No JSON. No markdown headers. Just the facts.`

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

  const prompt = `${businessContext}Analyzuj tuto konverzaci a poskytni JSON shrnutí.

ROLE:
- Zprávy označené [outbound] jsou OD MAJITELE EMAILOVÉHO ÚČTU (váš šéf, uživatel). Vždy je to uživatel, nikdy protistrana.
- Zprávy označené [inbound] jsou OD PROTISTRANY (externí kontakt).
- NIKDY nezaměňuj, kdo je kdo.

KONVERZACE:
${messageText}

Odpověz POUZE validním JSON v tomto formátu:
{
  "currentState": "Stručný popis aktuálního stavu konverzace/obchodu (česky)",
  "risks": ["Riziko 1 (česky)", "Riziko 2 (česky)"],
  "nextSteps": ["Další krok 1 (česky)", "Další krok 2 (česky)"],
  "keyPoints": ["Klíčový bod 1 (česky)", "Klíčový bod 2 (česky)"],
  "confidence": 0.75,
  "confidenceReason": "Proč tato úroveň jistoty — jaké důkazy podporují nebo omezují vaše porozumění (česky)",
  "dealType": "sale"
}

PRAVIDLA:
- confidence: 0.0 až 1.0 — jak jste si jisti přesností shrnutí.
- confidenceReason: Vysvětlete PROČ tato úroveň jistoty — ne jak analýza probíhala.
- dealType: "sale", "purchase", "rental", "lease", "consultation", "other", nebo null pokud nejde o obchod.

Buďte struční. Zaměřte se na akční závěry.`

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
  weight: number
  dealType: DealType
  suggestedLocation?: string | null
  suggestedTime?: string | null
}> {
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

  const prompt = `${systemContext}

${channelNote}
${highValueNote}

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
  "dollarValue": estimated deal value in ${settings.typical_deal_size_currency} (0 if unknown, use range ${settings.typical_deal_size_min.toLocaleString()}-${settings.typical_deal_size_max.toLocaleString()} as reference),
  "painFactor": 1-10 (how much pain from ignoring this),
  "weight": 0-100 (how immovable/fixed is this action? 100 = must happen regardless of other priorities, 0 = flexible. E.g. legal deadline = 90, casual follow-up = 5),
  "dealType": "sale" | "purchase" | "rental" | "lease" | "consultation" | "other" | null (classify the nature of this deal/conversation),
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
  const prompt = `Write a brief, personal executive assistant-style morning briefing headline (2-3 sentences) in CZECH.\n\nTODAY'S SCHEDULE:\n${eventsText}\n\nPENDING ACTIONS:\n${actionsText}\n\n${tomorrowHighlights ? `TOMORROW: ${tomorrowHighlights.join(', ')}` : ''}\n\nWrite as if you're a thoughtful executive assistant giving a quick morning status. Be warm but professional. Focus on what matters most today.`
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
