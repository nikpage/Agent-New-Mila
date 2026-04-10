import type { ConversationSummary, ActionType, DealType, UserSettings } from '../supabase/types'
import { runAITask } from './runner'
import { getAISystemPrompt } from '@/config/client'

/**
 * Enriched text JSON schema (output of enrichMessage).
 */
export interface EnrichedMessageData {
  parties?: string[]
  subject?: string | null
  messageType?: string | null
  coreIntent?: string | null
  addresses?: string[]
  proposedTimes?: {
    original: string          // exact quote from message
    interpreted: string       // human-readable interpretation
    relativeRef?: string      // normalized: "today" | "tomorrow" | "day_after_tomorrow" | "this_week" | "next_week" | "specific_date" | "specific_day"
    specificDate?: string     // YYYY-MM-DD only when the message contains an explicit calendar date (e.g. "15. března", "March 15"). null for relative refs
    dayOfWeek?: string        // "monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday" — when a specific weekday is named
    timeOfDay?: string        // "HH:mm" 24h format, null if no time stated
    eventContext?: string     // "viewing"|"showing"|"signing"|"notary"|"legal"|"office_meeting"|"phone_call"|"online_meeting"|"deadline"|"delivery"|"other"
  }[]
  meetingType?: string | null
  urgency?: { quote: string; classification: string } | null
  dealStage?: string | null
  keyNumbers?: { price?: string | null; area?: string | null; dates?: string[] }
}

/**
 * Parse enriched text (JSON or legacy plain text).
 * Returns structured data if JSON, or null if plain text / parse failure.
 */
export function parseEnrichedText(text: string): EnrichedMessageData | null {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) return parsed
    return null
  } catch {
    return null
  }
}

/**
 * Convert enriched text to a readable string for contexts that need plain text.
 * If JSON, formats it as structured lines. If already plain text, returns as-is.
 */
export function enrichedTextToString(text: string): string {
  const parsed = parseEnrichedText(text)
  if (!parsed) return text // legacy plain text, return as-is

  const lines: string[] = []
  if (parsed.parties?.length) lines.push(`Strany: ${parsed.parties.join(', ')}`)
  if (parsed.subject) lines.push(`Předmět: ${parsed.subject}`)
  if (parsed.messageType) lines.push(`Typ: ${parsed.messageType}`)
  if (parsed.coreIntent) lines.push(`Záměr: ${parsed.coreIntent}`)
  if (parsed.addresses?.length) {
    for (const addr of parsed.addresses) lines.push(`Adresa: ${addr}`)
  }
  if (parsed.proposedTimes?.length) {
    for (const t of parsed.proposedTimes) lines.push(`Navrhovaný čas: '${t.original}' = ${t.interpreted}`)
  }
  if (parsed.meetingType) lines.push(`Typ schůzky: ${parsed.meetingType}`)
  if (parsed.urgency) lines.push(`Naléhavost: "${parsed.urgency.quote}" — ${parsed.urgency.classification}`)
  if (parsed.dealStage) lines.push(`Fáze obchodu: ${parsed.dealStage}`)
  if (parsed.keyNumbers) {
    const kn = parsed.keyNumbers
    if (kn.price) lines.push(`Cena: ${kn.price}`)
    if (kn.area) lines.push(`Plocha: ${kn.area}`)
    if (kn.dates?.length) lines.push(`Termíny: ${kn.dates.join(', ')}`)
  }
  return lines.join('\n')
}

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
 * Stage: enrichment (gemini-2.5-flash → claude-haiku)
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
    ? `BUSINESS CONTEXT: ${settings.client_company} — ${settings.business_specialization}. Market: ${settings.business_market}.${settings.office_location ? ` User's office: ${settings.office_location}.` : ''}${settings.home_location ? ` User's home: ${settings.home_location}.` : ''}${settings.lawyer_notary ? ` User's lawyer/notary: ${settings.lawyer_notary}.` : ''}\n`
    : ''

  const directionLabel = direction === 'outbound'
    ? 'sent BY the email account owner'
    : 'received FROM a counterparty'

  const outputLanguage = settings?.ai_language || 'Czech'
  const tz = settings?.timezone || 'Europe/Prague'
  const now = new Date()
  const todayStr = now.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz })
  const isoDate = now.toISOString().split('T')[0]

  const prompt = `${businessContext}TODAY'S DATE: ${todayStr} (${isoDate}). Extract relative date references as-is — do NOT compute absolute dates. Just classify what kind of reference it is.

Extract key information from this message the way a human assistant would read it. Only include what's actually present. Do not invent or guess. Leave out anything not clearly supported by the text. Interpret terms in context of the business domain above — do NOT translate domain-specific words literally.

VOICE: Refer to the email account owner as "vy" (you), never as "uživatel" (the user). The counterparty is referred to by name or as "protistrana".
FORMATTING: Plain text only. No markdown, no ** bold **, no # headers.

Extract ALL of the following that are present:

- Who's involved (all parties mentioned, including names from signatures)
- What property, subject matter, or topic
- Message type (meeting request, question, offer, info, personal, admin, legal, update...)
- If deal-related: stage, key numbers (price, area, dates), commitments made
- If personal/admin: what it's about, any time sensitivity, any action needed
- Core intent (what this message actually says or asks)
- ADDRESSES: Extract EVERY physical address with a street name or building number mentioned ANYWHERE in the message — body, footer, signature. Examples: "Dykova 17, Praha 2", "Třinecká 672, Praha", "Sokolovská 46/51, Praha 8". Do NOT extract bare neighborhood or district names (e.g. "Vinohrady", "Smíchov", "Karlín") — those are areas, not addresses. Each address goes into the JSON addresses array as a plain string WITHOUT any prefix.
- PROPOSED TIMES: Extract EVERY specific time, day, or date the sender proposes or mentions for a meeting, viewing, appointment, deadline, or delivery. Write each as a separate line prefixed with "Navrhovaný čas:" and include the EXACT original phrasing plus your interpretation (e.g. "Navrhovaný čas: 'tomorrow at 2pm' = úterý 17. března 14:00" or "Navrhovaný čas: 'Can we meet at 9 or 10?' = 9:00 nebo 10:00"). Do NOT drop times. Do NOT convert 2pm to 20:00.
- MEETING TYPE: If a meeting, viewing, signing, or appointment is discussed, note what kind (e.g. "Typ schůzky: prohlídka bytu", "Typ schůzky: podpis u notáře", "Typ schůzky: jednání o nájmu").
- Urgency signals: Find ONE phrase (10 words max) that indicates time pressure. Write it once. Classify as HARD DEADLINE (explicit date/day or stated consequence) or SOFT REFERENCE (vague, no consequence). Omit entirely if none present.

Channel: ${channel}
Direction: ${direction} (${directionLabel})
${contextBlock}
MESSAGE:
${cleanedText.slice(0, 3000)}

Respond with ONLY valid JSON matching this exact schema. No markdown. No backticks. No prose outside the JSON.

{
  "parties": ["string"],
  "subject": "string | null",
  "messageType": "string | null",
  "coreIntent": "string | null",
  "addresses": ["string"],
  "proposedTimes": [{"original": "exact quote from message", "interpreted": "human-readable in Czech", "relativeRef": "today | tomorrow | day_after_tomorrow | this_week | next_week | specific_date | specific_day", "specificDate": "YYYY-MM-DD — ONLY when the message states an explicit calendar date like '15. března' or '2025-03-15'. null for relative references like 'zítra' or 'v pátek'.", "dayOfWeek": "monday|tuesday|...|sunday — when a named weekday is mentioned, e.g. 'v pátek' → 'friday'. null otherwise.", "timeOfDay": "HH:mm (24h) — e.g. 'v 9:00' → '09:00', 'at 2pm' → '14:00'. null if no time mentioned.", "eventContext": "viewing | showing | signing | notary | legal | office_meeting | phone_call | online_meeting | deadline | delivery | other"}],
  "meetingType": "string | null",
  "urgency": {"quote": "string", "classification": "HARD DEADLINE | SOFT REFERENCE"} | null,
  "dealStage": "string | null",
  "keyNumbers": {"price": "string | null", "area": "string | null", "dates": ["string"]}
}

Omit any key where nothing is present. Do not invent values.

CRITICAL: You must generate ALL text values in ${outputLanguage}. Do not output English.`

  const raw = (await runAITask('enrichment', prompt)).trim()

  // Validate JSON output; if the model returned valid JSON, extract and re-serialize
  // to strip any extra text. If parsing fails, return the raw text (backward compat).
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      return JSON.stringify(parsed)
    } catch {
      // JSON parse failed — fall through to return raw
    }
  }
  return raw
}

/**
 * Extract the CP's current request from the latest inbound message.
 * Focused single-task call that runs BEFORE planning to lock in what the
 * CP is actually asking — prevents intent drift where the planning AI latches
 * onto conversation history instead of the latest message.
 * Stage: enrichment (cheap, Gemini Flash)
 */
export async function extractCPRequest(
  latestInboundText: string,
  cpName: string | null,
  settings?: UserSettings
): Promise<string> {
  const lang = settings?.ai_language || 'Czech'
  const prompt = `Read this message from ${cpName || 'the counterparty'} and answer concisely:

1. What is the sender specifically ASKING, REQUESTING, or DEMANDING? Quote their key words.
2. What response do they expect (a reply, a meeting confirmation, documents, information)?
3. Is there a deadline? Quote it if yes.

If the message is purely informational with no request, say "No specific request — informational update."

MESSAGE:
${latestInboundText.slice(0, 2000)}

Respond in ${lang}. Plain text, 2-4 sentences max.`

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
  settings?: UserSettings,
  /** Mila's journal beliefs about this CP/conversation — enriches summary with accumulated knowledge */
  journalNotes?: string
): Promise<ConversationSummary> {
  console.log(`[AI:analyzeConversation] Running stage 'analysis'`)
  const messageText = messages
    .map(m => `[${m.direction}] ${m.date.toISOString().split('T')[0]}: ${m.text}`)
    .join('\n\n')

  const businessContext = settings
    ? `${getAISystemPrompt(settings)}\n\n`
    : ''

  const analysisLang = settings?.ai_language || 'Czech'
  const prompt = `${businessContext}Analyze this conversation and provide a JSON summary.

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
${journalNotes ? `\nMILA'S ACCUMULATED KNOWLEDGE (beliefs and observations about this CP/deal — incorporate into your summary):\n${journalNotes}` : ''}

Respond with ONLY valid JSON in this exact format:
{
  "currentState": "Brief description of where this conversation/deal currently stands (addressing user as vy)",
  "risks": ["Risk 1", "Risk 2"],
  "nextSteps": ["Next step 1", "Next step 2"],
  "keyPoints": ["Key point 1", "Key point 2"],
  "confidence": 0.75,
  "confidenceReason": "Why you are this confident",
  "dealType": "sale"
}

FIELD RULES:
- confidence: 0.0 to 1.0 — how confident you are in the summary's accuracy. Consider: message count, message clarity, how much context is available, whether the conversation is coherent.
- confidenceReason: Explain WHY this confidence level — what evidence supports or limits your understanding. NOT how the analysis was done.
- dealType: one of "sale", "purchase", "rental", "lease", "consultation", "other", or null if not a deal/transaction.

Be concise. Focus on actionable insights.

CRITICAL: You must generate ALL text field values in ${analysisLang}. Do not output English.`

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
 * Assembled action proposal — built by planning.ts from the decomposed pipeline pieces.
 */
export type ProposedAction = {
  actionType: ActionType
  rationale_cs: string
  intent_cs: string
  missingInfo: { label: string; value: null }[]
  urgency: number
  dollarValue: number
  weight: number
  immovable?: boolean
  dealType: DealType
  suggestedLocation?: string | null
  locationConfidence?: 'high' | 'low' | null
  suggestedTime?: string | null
  meetingType?: 'address' | 'online' | 'phone'
  cpPhone?: string | null
}

/**
 * Output of decideActionType — narrow classification of what action type(s) are needed.
 */
export type ActionTypeDecision = {
  actionType: ActionType
  rationale_cs: string
}

/**
 * Output of generateIntent — content and metadata for a decided action type.
 */
export type ActionIntentResult = {
  intent_cs: string
  missingInfo: { label: string; value: null }[]
  dollarValue: number
  dealType: DealType
  meetingType?: 'address' | 'online' | 'phone'
  weight: number
  immovable?: boolean
  cpPhone?: string | null
}

/**
 * Decide what action type(s) are needed for a conversation.
 * Narrow prompt — classification only, no content generation.
 * Stage: planning_type (Haiku → Gemini Flash)
 */
export async function decideActionType(
  cpRequest: string,
  enrichedText: string,
  conversationSummary: ConversationSummary,
  cpName: string | null,
  settings: UserSettings
): Promise<ActionTypeDecision[]> {
  const lang = settings.ai_language || 'Czech'
  console.log(`[AI:decideActionType] Running stage 'planning_type' for ${cpName || 'unknown CP'}`)

  const prompt = `You are Mila, a proactive executive assistant. Based on this conversation, decide what action type(s) are needed.

CONVERSATION STATE:
${JSON.stringify(conversationSummary, null, 2)}

COUNTERPARTY: ${cpName || 'Unknown'}

CP'S CURRENT REQUEST:
${cpRequest || 'No specific request extracted.'}

ENRICHED DATA FROM LATEST MESSAGE:
${enrichedText || '(none)'}

ACTION TYPES:
1. REPLY — the user needs to send a message that is NOT related to any meeting or scheduling. Only use when there is NO meeting/viewing/appointment being discussed.
2. SCHEDULE — use whenever a meeting, viewing, appointment, or in-person event is involved:
   - CP confirmed or proposed a specific time → SCHEDULE
   - CP wants to meet but no time yet → SCHEDULE
   - CP asks to sign a contract in person → SCHEDULE
   - CP asks to confirm a deal/meeting → SCHEDULE (the calendar invite IS the confirmation)
   - Enriched data contains proposed times and/or meeting type → SCHEDULE
3. TODO — something the user needs to do themselves that is NOT a message and NOT a meeting (gather documents, review internally, get approval, prepare paperwork).

RULES:
- SCHEDULE ABSORBS REPLY: When SCHEDULE exists, do NOT add REPLY. The calendar invite IS the reply.
- CONFIRMATION = SCHEDULE: "potvrďte obchod", "confirm by 5pm", etc. → SCHEDULE, never TODO.
- Meeting times in enriched data → SCHEDULE must exist.
- STRONGLY PREFER ONE ACTION. Return TWO actions ONLY when ALL of these are true:
  a) One is SCHEDULE and the other is TODO
  b) The TODO is a BLOCKING prerequisite — user CANNOT attend the meeting without it (e.g. "přineste list vlastnictví", "get bank approval", "obtain certificate")
  c) The email EXPLICITLY states this requirement as something the user must bring/provide
- "Prepare notes", "review contract", "confirm details", "prepare for discussion" are NOT separate TODOs — that is normal meeting prep implied by SCHEDULE itself.
- When in doubt, return ONE action.
- You MUST return at least one action.

Respond with ONLY valid JSON array:
[{"actionType": "REPLY" | "SCHEDULE" | "TODO", "rationale_cs": "One sentence: why this action is needed now"}]

CRITICAL: rationale_cs must be in ${lang}. Do not output English.`

  const text = await runAITask('planning_type', prompt)

  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    const parsed = JSON.parse(arrayMatch[0])
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse action type decision')
  return [JSON.parse(jsonMatch[0])]
}

/**
 * Generate intent text and metadata for a decided action type.
 * Receives the locked action type — does not second-guess it.
 * Stage: planning_intent (Haiku → Gemini Flash)
 */
export async function generateIntent(
  decision: ActionTypeDecision,
  cpRequest: string,
  enrichedText: string,
  conversationSummary: ConversationSummary,
  cpName: string | null,
  settings: UserSettings,
  channel: 'email' | 'whatsapp' = 'email',
  journalText: string = ''
): Promise<ActionIntentResult> {
  const lang = settings.ai_language || 'Czech'
  console.log(`[AI:generateIntent] Running stage 'planning_intent' for ${cpName || 'unknown CP'} (${decision.actionType})`)

  const systemContext = getAISystemPrompt(settings, { excludeLawyerNotary: true })
  const channelNote = channel === 'whatsapp'
    ? 'CHANNEL: WhatsApp — keep messages short, informal, no subject line needed.'
    : 'CHANNEL: Email — standard professional format.'

  const prompt = `${systemContext}

${channelNote}

You are Mila, a proactive executive assistant. The action type has already been decided. Your job: generate the intent description and metadata for this action.

ACTION TYPE (already decided — do NOT change): ${decision.actionType}
RATIONALE: ${decision.rationale_cs}

COUNTERPARTY: ${cpName || 'Unknown'}

CP'S CURRENT REQUEST:
${cpRequest || 'No specific request extracted.'}

CONVERSATION STATE:
${JSON.stringify(conversationSummary, null, 2)}

ENRICHED DATA:
${enrichedText || '(none)'}
${journalText ? `\nMILA'S NOTES (accumulated beliefs about this CP/deal):\n${journalText}` : ''}

CRITICAL — VOICE AND PERSPECTIVE:
- Address the user as "vy" (you). NEVER say "uživatel" (the user).
- intent_cs describes what Mila HAS ALREADY DONE + what she WILL DO when user clicks UDĚLAT.
- Be maximally specific: names, dates, amounts, locations from the conversation.

CRITICAL — FORMATTING:
- Plain text only. No markdown. No ** bold **. No # headers.

ACTION-SPECIFIC RULES:
- TODO: intent_cs is a numbered checklist. Each item is max 6 words: verb + object. Example: "1. Zajistit list vlastnictví\\n2. Ověřit bezdlužnost SVJ\\n3. Připravit plnou moc". NO addresses, dates, parenthetical details, or explanations in items. Max 4 items.
- REPLY: intent_cs is ONE sentence (max 20 words) describing what Mila will write. NOT a numbered list. Example: "Potvrdí dostupnost bytu a navrhne termíny prohlídky."
- SCHEDULE: intent_cs is ONE sentence (max 20 words) describing the meeting. NOT a numbered list. Example: "Naplánuje telefonát s Evou na zítra v 9:00 k doladění smlouvy."
- Mila CANNOT act autonomously between briefs. NEVER promise to "track", "monitor", "follow up later".

Do NOT assign urgency, suggestedLocation, or suggestedTime — those are computed separately.

Respond with ONLY valid JSON:
{
  "intent_cs": "Proactive description in ${lang}",
  "missingInfo": [{"label": "Full question in ${lang}", "value": null}],
  "dollarValue": estimated deal value in ${settings.typical_deal_size_currency} (0 if unknown, range ${settings.typical_deal_size_min.toLocaleString()}-${settings.typical_deal_size_max.toLocaleString()} as reference),
  "dealType": "sale" | "purchase" | "rental" | "lease" | "consultation" | "other" | null,
  "meetingType": "'address' for in-person, 'online' for video calls, 'phone' for phone calls. Default 'address' for SCHEDULE. Omit for non-SCHEDULE.",
  "weight": 1-10 (immovability: 1=easy to reschedule, 10=hard to move),
  "immovable": true only for absolutely immovable (court dates, kids events, airport pickups). Omit or false otherwise,
  "cpPhone": "international phone number from conversation or null"
}

CRITICAL: All user-facing text (intent_cs, missingInfo labels) must be in ${lang}. Do not output English.`

  const text = await runAITask('planning_intent', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse action intent')

  const parsed = JSON.parse(jsonMatch[0])
  return {
    intent_cs: parsed.intent_cs || '',
    missingInfo: Array.isArray(parsed.missingInfo) ? parsed.missingInfo : [],
    dollarValue: typeof parsed.dollarValue === 'number' ? parsed.dollarValue : 0,
    dealType: parsed.dealType || null,
    meetingType: parsed.meetingType || undefined,
    weight: typeof parsed.weight === 'number' ? parsed.weight : 0,
    immovable: parsed.immovable === true ? true : undefined,
    cpPhone: parsed.cpPhone || null,
  }
}

/**
 * Extract the topic of a conversation.
 * Stage: threading (gemini-2.5-flash → claude-sonnet)
 */
export async function extractTopic(messages: { text: string }[], settings?: UserSettings): Promise<string> {
  console.log(`[AI:extractTopic] Running stage 'threading'`)
  const topicLang = settings?.ai_language || 'Czech'
  const messageTexts = messages.slice(0, 5).map(m => m.text.slice(0, 300)).join('\n---\n')
  const prompt = `What is the main topic of this email conversation? Respond with ONLY a brief topic (3-7 words) in ${topicLang}.\n\n${messageTexts}`
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
 * Classify an email into category.
 * Stage: classify (gemini-2.5-flash-lite → claude-haiku)
 */
export async function classifyEmail(
  subject: string,
  body: string,
  from: string
): Promise<{
  isActionable: boolean
  category: 'meeting_request' | 'question' | 'update' | 'confirmation' | 'newsletter' | 'spam' | 'other'
}> {
  console.log(`[AI:classifyEmail] Running stage 'classify'`)
  const prompt = `Classify this email.\n\nFROM: ${from}\nSUBJECT: ${subject}\nBODY: ${body.slice(0, 1000)}\n\nRespond with ONLY valid JSON:\n{\n  "isActionable": true/false (does this require user action?),\n  "category": "meeting_request" | "question" | "update" | "confirmation" | "newsletter" | "spam" | "other"\n}\n\nNewsletters, automated emails, and spam are NOT actionable.`
  const text = await runAITask('classify', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { isActionable: false, category: 'other' }
  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      isActionable: parsed.isActionable === true,
      category: parsed.category || 'other',
    }
  } catch {
    return { isActionable: false, category: 'other' }
  }
}
