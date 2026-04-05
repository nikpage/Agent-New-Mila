import type { ConversationSummary, ActionType, DealType, UserSettings } from '../supabase/types'
import { runAITask } from './runner'
import { getAISystemPrompt, containsHighValueSignals } from '@/config/client'

/**
 * Enriched text JSON schema (output of enrichMessage).
 */
export interface EnrichedMessageData {
  parties?: string[]
  subject?: string | null
  messageType?: string | null
  coreIntent?: string | null
  addresses?: string[]
  proposedTimes?: { original: string; interpreted: string }[]
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

  const prompt = `${businessContext}TODAY'S DATE: ${todayStr} (${isoDate}). Use this to convert relative dates ("zítra", "příští týden", "v pátek") to absolute dates in the Navrhovaný čas extraction.

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
- ADDRESSES: Extract EVERY physical address, location, or place name mentioned ANYWHERE in the message — including the body, footer, and email signature. Examples: office address, meeting venue, property address, notary office, company HQ. Write each as a separate line prefixed with "Adresa:" (e.g. "Adresa: Dykova 17, Praha 2"). Include partial addresses too (e.g. "Adresa: u notáře, Praha 2").
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
  "proposedTimes": [{"original": "string", "interpreted": "string"}],
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
 * Determine what action should be proposed (Intent Only - NO DRAFTS)
 *
 * Two-stage architecture:
 *   Stage 1 (triage): Lightweight prompt decides action type(s), urgency, deal value.
 *   Stage 2 (detail): One focused prompt PER action type fills in type-specific fields.
 *   This prevents SCHEDULE rules from competing with TODO rules for attention.
 *
 * Both stages use the 'planning' AI stage (claude-haiku with thinking).
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

// --- Shared helpers for the two-stage planning prompts ---

interface PlanningContext {
  systemContext: string
  channelNote: string
  highValueNote: string
  todayStr: string
  isoDate: string
  timeStr: string
  tz: string
  tomorrowDate: string
  nextWeekDate: string
  recentText: string
  cpName: string | null
  planningLang: string
  conversationSummary: ConversationSummary
}

function buildPlanningContext(
  conversationSummary: ConversationSummary,
  recentMessages: { direction: string; text: string }[],
  cpName: string | null,
  settings: UserSettings,
  channel: 'email' | 'whatsapp'
): PlanningContext {
  const recentText = recentMessages
    .map(m => `[${m.direction}]: ${m.text}`)
    .join('\n\n')

  const systemContext = getAISystemPrompt(settings, { excludeLawyerNotary: true })
  const channelNote = channel === 'whatsapp'
    ? 'CHANNEL: WhatsApp — keep messages short, informal, no subject line needed.'
    : 'CHANNEL: Email — standard professional format.'

  const conversationText = recentMessages.map(m => m.text).join(' ')
  const isHighValue = containsHighValueSignals(conversationText, settings)
  const highValueNote = isHighValue
    ? 'HIGH-VALUE DEAL DETECTED — this conversation matches high-value signals. Estimate dollar value carefully.'
    : ''

  const now = new Date()
  const tz = settings.timezone || 'Europe/Prague'
  const todayStr = now.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz })
  const timeStr = now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const isoDate = now.toISOString().split('T')[0]

  return {
    systemContext,
    channelNote,
    highValueNote,
    todayStr,
    isoDate,
    timeStr,
    tz,
    tomorrowDate: new Date(now.getTime() + 86400000).toISOString().split('T')[0],
    nextWeekDate: new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0],
    recentText,
    cpName,
    planningLang: settings.ai_language || 'Czech',
    conversationSummary,
  }
}

function buildPreamble(ctx: PlanningContext): string {
  return `${ctx.systemContext}

${ctx.channelNote}
${ctx.highValueNote}

TODAY'S DATE: ${ctx.todayStr} (${ctx.isoDate}), current time: ${ctx.timeStr}, timezone: ${ctx.tz}
Resolve relative dates: "tomorrow" = ${ctx.tomorrowDate}, "next week" = week of ${ctx.nextWeekDate}.

You are Mila, reviewing a DEAL IN PROGRESS. Your input is a conversation — an ongoing relationship between your boss and a counterparty. The recent timeline entries below show what just happened. Your job is to decide the NEXT MOVE to advance this deal.

Think about: (1) Where does this deal stand? (2) What just changed? (3) What should happen next?

ROLE KEY: [outbound] = your boss (the user). [inbound] = the counterparty (${ctx.cpName || 'the other party'}).

DEAL STATE:
${JSON.stringify(ctx.conversationSummary, null, 2)}

RECENT TIMELINE:
${ctx.recentText}

COUNTERPARTY: ${ctx.cpName || 'Unknown'}`
}

const URGENCY_RULES = `URGENCY RULES (MUST FOLLOW EXACTLY):
Urgency is based ONLY on deadline language explicitly stated in the conversation.

Scale:
  10 = HARD deadline TODAY ("dnes", "today", "do 17:00")
  9 = HARD deadline TOMORROW ("zítra", "tomorrow")
  7-8 = HARD deadline THIS WEEK with SPECIFIC DAY or stated consequence
  5 = SOFT time reference ("tento týden", "brzy") — no specific day
  3-4 = Within 2-4 weeks
  2 = DEFAULT when NO deadline language exists
  1 = Explicitly stated no rush

HARD RULES:
- "žádný spěch" / "no rush" → urgency 1.
- NO deadline language at all → urgency 2. Not 3, not 5, not 7.
- urgency 7+ requires HARD DEADLINE with specific date/day or stated consequence.
- Deal value does NOT increase urgency. A 45M deal with no deadline is urgency 2.`

// --- Stage 1: Triage — decide WHAT action types are needed ---

interface TriageResult {
  actionType: ActionType
  reasoning: string
  urgency: number
  urgencyJustification: string
  dollarValue: number
  weight: number
  immovable: boolean
  dealType: DealType
}

async function triageActions(ctx: PlanningContext, settings: UserSettings): Promise<TriageResult[]> {
  const prompt = `${buildPreamble(ctx)}

Based on where this deal stands and what just happened in the timeline, decide the next move.

NEXT MOVE OPTIONS:
1. REPLY — the conversation needs a response to the counterparty. This is the natural next step for most deals: someone wrote, now your boss writes back.
2. SCHEDULE — a meeting, viewing, or appointment needs to be booked. The calendar invite IS the reply — never return SCHEDULE + REPLY together.
3. TODO — your boss needs to complete an offline task BEFORE the deal can move forward. This is rare. Only use when the deal is genuinely BLOCKED until the user does something that takes days or involves a third party (e.g. call the bank, hire a photographer, visit a site).

HOW TO CHOOSE:
Look at the deal state and the latest timeline entry. Ask: "What moves this deal forward?"
- If the CP asked questions, made an offer, or proposed something → REPLY (the user knows their own business and can answer)
- If a meeting is being discussed → SCHEDULE
- If the deal literally cannot advance until the user does offline work → TODO

Do NOT invent preparation work. The user is a professional. If the CP asked "is the flat available?" or "what's the price?" — that's a REPLY, not a TODO to "research availability." The user knows.

RULES:
- Return at least one action.
- Never return two actions that accomplish the same thing.
- SCHEDULE absorbs REPLY — never return both.

${URGENCY_RULES}

Respond with ONLY valid JSON array:
[{
  "actionType": "REPLY" | "SCHEDULE" | "TODO",
  "reasoning": "1-2 sentences: why this is the next move for this deal",
  "urgency": 1-10,
  "urgencyJustification": "Quote exact deadline words from the timeline, or 'No deadline language found.'",
  "dollarValue": estimated value in ${settings.typical_deal_size_currency} (0 if unknown, range ${settings.typical_deal_size_min.toLocaleString()}-${settings.typical_deal_size_max.toLocaleString()} as reference),
  "weight": 1-10 (immovability, 1=easy to reschedule, 10=very hard to move),
  "immovable": true only for absolutely fixed commitments (court, flights, school). Default false,
  "dealType": "sale"|"purchase"|"rental"|"lease"|"consultation"|"other"|null
}]

CRITICAL: Generate reasoning in ${ctx.planningLang}. Do not output English.`

  const text = await runAITask('planning', prompt)
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    const parsed = JSON.parse(arrayMatch[0])
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse triage result')
  return [JSON.parse(jsonMatch[0])]
}

// --- Stage 2: Detail fill — one focused prompt per action type ---

async function fillReplyDetails(
  ctx: PlanningContext,
  triage: TriageResult
): Promise<ProposedAction> {
  const prompt = `${buildPreamble(ctx)}

The next move for this deal is REPLY — your boss needs to respond to the counterparty.

WHY: ${triage.reasoning}

VOICE: Address user as "vy". Never "uživatel". Plain text only, no markdown.

Respond with ONLY valid JSON:
{
  "rationale_cs": "One sentence in ${ctx.planningLang}: why sending this reply advances the deal. Focus on what's at stake or what the CP is waiting for.",
  "intent_cs": "What Mila will prepare: reference SPECIFIC data from the deal (names, property, amounts, questions asked). Describe the message content.",
  "missingInfo": [{"label": "Question the CP asked that needs answering, in ${ctx.planningLang}", "value": null}]
}

RULES:
- intent_cs must reference specific facts from the timeline — not generic "answer questions."
- rationale_cs and intent_cs must NOT repeat each other.
- missingInfo: extract ALL open questions from the CP. Full question text, not keywords.

CRITICAL: All text in ${ctx.planningLang}. Do not output English.`

  const text = await runAITask('planning', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse REPLY details')
  const detail = JSON.parse(jsonMatch[0])

  return {
    actionType: 'REPLY',
    rationale_cs: detail.rationale_cs || triage.reasoning,
    intent_cs: detail.intent_cs || '',
    missingInfo: Array.isArray(detail.missingInfo) ? detail.missingInfo : [],
    urgency: triage.urgency,
    dollarValue: triage.dollarValue,
    weight: triage.weight,
    immovable: triage.immovable,
    dealType: triage.dealType,
  }
}

async function fillScheduleDetails(
  ctx: PlanningContext,
  triage: TriageResult
): Promise<ProposedAction> {
  const prompt = `${buildPreamble(ctx)}

The next move for this deal is SCHEDULE — a meeting needs to be booked.

WHY: ${triage.reasoning}

VOICE: Address user as "vy". Never "uživatel". Plain text only, no markdown.

The calendar invite IS the reply to the counterparty. intent_cs must describe BOTH what the reply will say AND what meeting is being booked.

Respond with ONLY valid JSON:
{
  "rationale_cs": "One sentence in ${ctx.planningLang}: why this meeting matters NOW.",
  "intent_cs": "What Mila HAS DONE and WILL DO: describe both the meeting booking AND any CP questions to answer in the invite.",
  "missingInfo": [{"label": "FULL question in ${ctx.planningLang}", "value": null}],
  "meetingType": "address | online | phone",
  "cpPhone": "+420... or null",
  "suggestedLocation": "Physical address WHERE PEOPLE WILL MEET — the MEETING VENUE, NOT the property or deal subject. ADDRESS INFERENCE for SCHEDULE — Priority: (1) explicit venue stated in conversation, (2) CP's office address from signature IF meeting is at their place, (3) user's office address if CP says 'at your office', (4) the property address ONLY if the meeting is literally at the property (e.g. a viewing/inspection). Addresses in email signatures are the SENDER's company address — do not confuse with meeting venue. A conversation about 'office space in Karlin' does NOT mean the meeting is in Karlin. null if unknown.",
  "locationConfidence": "high | low | null",
  "suggestedTime": "ISO 8601 datetime. Convert proposedTimes/Navrhovaný čas to ISO 8601 using TODAY'S DATE above. Approximate times: 'ráno'→09:00, 'odpoledne'→14:00. CP-stated times always extracted exactly (even weekends). Self-generated times must respect working hours. null only if no time reference exists.",
  "cpAvailability": "Free-text CP availability or null"
}

RULES:
- suggestedTime = time of the ACTUAL MEETING, not a slot to "send the invitation".
- meetingType: 'phone' when conversation suggests a call ('zavolám', 'můžeme si zavolat'). 'online' for video. Default 'address'.
- rationale_cs and intent_cs must NOT repeat each other.

CRITICAL: All text in ${ctx.planningLang}. Do not output English.`

  const text = await runAITask('planning', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse SCHEDULE details')
  const detail = JSON.parse(jsonMatch[0])

  return {
    actionType: 'SCHEDULE',
    rationale_cs: detail.rationale_cs || triage.reasoning,
    intent_cs: detail.intent_cs || '',
    missingInfo: Array.isArray(detail.missingInfo) ? detail.missingInfo : [],
    urgency: triage.urgency,
    dollarValue: triage.dollarValue,
    weight: triage.weight,
    immovable: triage.immovable,
    dealType: triage.dealType,
    meetingType: detail.meetingType || 'address',
    cpPhone: detail.cpPhone || null,
    suggestedLocation: detail.suggestedLocation || null,
    locationConfidence: detail.locationConfidence || null,
    suggestedTime: detail.suggestedTime || null,
  }
}

async function fillTodoDetails(
  ctx: PlanningContext,
  triage: TriageResult
): Promise<ProposedAction> {
  const prompt = `${buildPreamble(ctx)}

The next move for this deal is TODO — the deal is blocked until your boss completes an offline task.

WHY: ${triage.reasoning}

VOICE: Address user as "vy". Never "uživatel". Plain text only, no markdown.

Respond with ONLY valid JSON:
{
  "rationale_cs": "One sentence in ${ctx.planningLang}: what is blocking the deal and why this task unblocks it.",
  "intent_cs": "ONE sentence: the specific offline task. Name the third party or physical action required."
}

RULES:
- Mila CANNOT act autonomously. Never promise to "track", "monitor", "follow up", or "call if no reply".
- rationale_cs and intent_cs must NOT repeat each other.

CRITICAL: All text in ${ctx.planningLang}. Do not output English.`

  const text = await runAITask('planning', prompt)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse TODO details')
  const detail = JSON.parse(jsonMatch[0])

  return {
    actionType: 'TODO',
    rationale_cs: detail.rationale_cs || triage.reasoning,
    intent_cs: detail.intent_cs || '',
    missingInfo: [],
    urgency: triage.urgency,
    dollarValue: triage.dollarValue,
    weight: triage.weight,
    immovable: triage.immovable,
    dealType: triage.dealType,
  }
}

// --- Orchestrator ---

export async function proposeAction(
  conversationSummary: ConversationSummary,
  recentMessages: { direction: string; text: string }[],
  cpName: string | null,
  settings: UserSettings,
  channel: 'email' | 'whatsapp' = 'email'
): Promise<ProposedAction[]> {
  console.log(`[AI:proposeAction] Running 2-stage planning for ${cpName || 'unknown CP'}`)

  const ctx = buildPlanningContext(conversationSummary, recentMessages, cpName, settings, channel)

  // Stage 1: Triage — decide action types
  const triageResults = await triageActions(ctx, settings)
  console.log(`[AI:proposeAction] Triage: ${triageResults.map(t => `${t.actionType}(u${t.urgency})`).join(', ')}`)

  // Stage 2: Fill details in parallel — each type gets only its own rules
  const detailPromises = triageResults.map(triage => {
    switch (triage.actionType) {
      case 'REPLY': return fillReplyDetails(ctx, triage)
      case 'SCHEDULE': return fillScheduleDetails(ctx, triage)
      case 'TODO': return fillTodoDetails(ctx, triage)
      default: return fillReplyDetails(ctx, triage) // safe fallback
    }
  })

  let actions = await Promise.all(detailPromises)

  // Two-pass urgency review (same as before)
  const needsReview = actions.some(a => (a.urgency || 0) >= 5)
  if (needsReview) {
    try {
      actions = await reviewUrgency(actions, ctx.recentText)
    } catch (e) {
      console.error('[Planning] Urgency review failed, using original values:', e)
    }
  }

  return actions
}

/**
 * Second-pass urgency review. A cheap model reviews urgency claims against the conversation.
 * Receives ONLY the urgency scale, the proposed urgency + justification, and the raw conversation.
 * Does NOT receive deal value, CP name, or high-value flags — strips bias.
 * Stage: urgency_review (gemini-2.5-flash → claude-haiku)
 */
async function reviewUrgency(
  actions: ProposedAction[],
  conversationText: string
): Promise<ProposedAction[]> {
  const actionsToReview = actions
    .map((a, i) => ({ index: i, urgency: a.urgency || 0, justification: (a as Record<string, unknown>).urgencyJustification || '' }))

  if (actionsToReview.length === 0) return actions

  const reviewPrompt = `You are an urgency auditor. Your ONLY job: check if the claimed urgency matches the conversation text per the scale below. You receive NO deal value, NO names — only the conversation and the claims.

URGENCY SCALE:
  10 = HARD deadline TODAY (explicit: "dnes", "today", "do 17:00")
  9 = HARD deadline TOMORROW (explicit: "zítra", "tomorrow")
  7-8 = HARD deadline THIS WEEK with a SPECIFIC DAY named ("do pátku", "ve středu") or stated consequence ("jinak odstoupím", "otherwise we walk")
  5 = SOFT time reference ("tento týden", "brzy", "v nejbližších dnech") — NO specific day, NO consequence
  3-4 = Within 2-4 weeks ("příští měsíc", "do konce dubna", "v průběhu příštích týdnů")
  2 = DEFAULT when NO deadline language exists
  1 = Explicitly stated no rush

HARD RULES:
- urgency 7+ requires a HARD DEADLINE with a specific date/day or stated consequence quoted from the conversation
- "do konce dubna" when today is late March = 3-4 (weeks away), NOT 7+
- Deal importance, relationship importance, or dollar value do NOT increase urgency
- If the justification quotes words not actually present in the conversation, lower urgency to 2

CONVERSATION TEXT:
${conversationText.slice(0, 3000)}

CLAIMS TO REVIEW:
${actionsToReview.map(a => `Action ${a.index}: claimed urgency ${a.urgency}, justification: "${a.justification}"`).join('\n')}

For each action, return the corrected urgency. If the claim is justified, keep it. If not, return what it should be.

Respond with ONLY valid JSON array:
[{"index": 0, "correctedUrgency": N, "reason": "brief reason"}]`

  const text = await runAITask('urgency_review', reviewPrompt)
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return actions

  const reviews: { index: number; correctedUrgency: number; reason: string }[] = JSON.parse(jsonMatch[0])
  for (const review of reviews) {
    if (review.index >= 0 && review.index < actions.length) {
      const original = actions[review.index].urgency
      if (review.correctedUrgency !== original) {
        console.log(`[Planning] Urgency review: action ${review.index} corrected ${original} → ${review.correctedUrgency} (${review.reason})`)
      }
      actions[review.index].urgency = review.correctedUrgency
    }
  }

  return actions
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
