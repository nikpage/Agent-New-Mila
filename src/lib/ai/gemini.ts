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


// ─── Triage (single-pass planning) ─────────────────────────────────────────

export interface TriageAction {
  type: ActionType
  intent_cs: string
  rationale_cs: string
  urgency_category: 'CRITICAL' | 'TODAY' | 'THIS_WEEK' | 'SOON' | 'NONE'
  urgency_justification: string
  what_cp_wants: string
  venue_index: number | null
  time_index: number | null
  deal_type: DealType | null
  weight: number
  immovable: boolean
  missing_info: { label: string; value: null }[]
}

export interface TriageResult {
  needs_action: boolean
  reasoning: string
  confidence: number
  revisit_at: string | null
  revisit_reason: string | null
  action?: TriageAction
  secondary_action?: TriageAction | null
}

/**
 * Single-pass triage: decides whether a conversation needs action, what type,
 * urgency, venue, intent — or "not now, revisit later".
 * Stage: triage (claude-sonnet + extended thinking → gemini-2.5-flash)
 */
export async function triageConversation(
  latestInboundText: string,
  recentMessages: { direction: string; text: string; age: string }[],
  summary: ConversationSummary | null,
  pendingActions: { type: string; intent: string; urgency: number }[],
  cpName: string,
  channel: 'email' | 'whatsapp',
  settings: UserSettings,
  journalText: string,
  enrichment: EnrichedMessageData | null,
): Promise<TriageResult> {
  console.log(`[AI:triageConversation] Running stage 'triage' for ${cpName}`)

  const systemContext = getAISystemPrompt(settings)
  const now = new Date()
  const tz = settings.timezone || 'Europe/Prague'
  const todayStr = now.toLocaleDateString('cs-CZ', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })
  const isoDate = now.toLocaleDateString('sv-SE', { timeZone: tz })
  const timeStr = now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  const tomorrowDate = new Date(now.getTime() + 86400000).toISOString().split('T')[0]
  const nextWeekDate = new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0]

  const lang = settings.ai_language || 'Czech'
  const channelNote = channel === 'whatsapp'
    ? 'CHANNEL: WhatsApp — keep messages short, informal.'
    : 'CHANNEL: Email — standard professional format.'

  const recentText = recentMessages
    .map(m => `[${m.direction === 'outbound' ? 'out' : 'in'} ${m.age}] ${m.text}`)
    .join('\n\n')

  const pendingText = pendingActions.length > 0
    ? pendingActions.map(a => `- ${a.type}: "${a.intent}" (urgency ${a.urgency})`).join('\n')
    : '(none)'

  const summaryBlock = summary
    ? `CONVERSATION SUMMARY:\n- Current state: ${summary.currentState}\n- Risks: ${(summary.risks || []).join(', ') || 'none'}\n- Next steps: ${(summary.nextSteps || []).join(', ') || 'none'}`
    : 'CONVERSATION SUMMARY: (none available)'

  // Build enrichment facts block for pick-from-list
  let enrichmentBlock = ''
  if (enrichment) {
    const parts: string[] = ['FACTS FROM ENRICHMENT (already extracted — use these, do NOT re-extract):']

    if (enrichment.addresses?.length) {
      parts.push('ADDRESSES found in message:')
      enrichment.addresses.forEach((addr, i) => parts.push(`  ${i}: ${addr}`))
    } else {
      parts.push('ADDRESSES: (none found)')
    }

    if (enrichment.proposedTimes?.length) {
      parts.push('PROPOSED TIMES found in message:')
      enrichment.proposedTimes.forEach((t, i) => {
        const dateInfo = t.specificDate ? ` (${t.specificDate})` : t.dayOfWeek ? ` (${t.dayOfWeek})` : ''
        const timeInfo = t.timeOfDay ? ` at ${t.timeOfDay}` : ''
        parts.push(`  ${i}: "${t.original}" → ${t.interpreted}${dateInfo}${timeInfo}`)
      })
    } else {
      parts.push('PROPOSED TIMES: (none found)')
    }

    if (enrichment.meetingType) {
      parts.push(`MEETING TYPE: ${enrichment.meetingType}`)
    }

    if (enrichment.keyNumbers?.price) {
      parts.push(`DEAL VALUE: ${enrichment.keyNumbers.price}`)
    }

    if (enrichment.urgency) {
      parts.push(`URGENCY SIGNAL: "${enrichment.urgency.quote}" [${enrichment.urgency.classification}]`)
    } else {
      parts.push('URGENCY SIGNAL: (none found)')
    }

    enrichmentBlock = parts.join('\n')
  }

  const prompt = `${systemContext}

${channelNote}

TODAY'S DATE: ${todayStr} (${isoDate}), current time: ${timeStr}, timezone: ${tz}
Use this to resolve relative dates: "tomorrow" = ${tomorrowDate}, "next week" = week of ${nextWeekDate}.

You are Mila, a proactive executive assistant. Analyze this conversation and decide what to do.

ROLE IDENTIFICATION:
- Messages marked [out] are sent BY YOUR BOSS (the email account owner).
- Messages marked [in] are FROM THE COUNTERPARTY (${cpName}).
- NEVER confuse who is who.

${enrichmentBlock}

${summaryBlock}

EXISTING PENDING ACTIONS FOR THIS CONVERSATION:
${pendingText}

RECENT MESSAGES:
${recentText}

LATEST INBOUND MESSAGE:
${latestInboundText.slice(0, 3000)}
${journalText ? `\nMILA'S NOTES (accumulated beliefs about this CP/deal):\n${journalText}` : ''}

DECIDE one of three outcomes:

OUTCOME 1 — needs_action: false, no revisit
Conversation needs nothing. Use when: confirmations, FYIs, thank-yous, messages where a pending action already covers the request, routine updates with no new request.

OUTCOME 2 — needs_action: false, with revisit_at
No action needed NOW, but something is expected on a future date. Examples:
- CP says "I'll send the contract Monday" → revisit_at: "${nextWeekDate}", revisit_reason: "CP promised to send contract by Monday"
- CP says "Let me check with my wife this weekend" → revisit_at the Monday after
- CP says "We'll have the appraisal results in two weeks" → revisit_at 2 weeks from now
revisit_at = the date AFTER which Mila should check back. If date is vague, use the last reasonable day. If no date reference, don't set revisit_at.

OUTCOME 3 — needs_action: true
CP is making a new request that requires user action. NOT already covered by an existing pending action.

RULES:
- confidence below 0.6 → system will discard the proposal
- secondary_action: ONLY when a TODO is a BLOCKING prerequisite for a SCHEDULE AND the email EXPLICITLY states this requirement (e.g. "bring the ownership certificate to the signing")
- ACTION TYPES:
  REPLY — user needs to send a message NOT related to scheduling
  SCHEDULE — meeting/viewing/appointment/signing/call involved. SCHEDULE ABSORBS REPLY.
  TODO — user needs to do something that is NOT a message and NOT a meeting
- intent_cs formatting:
  TODO = numbered checklist (max 4 items, max 6 words each: verb + object)
  REPLY/SCHEDULE = one sentence, max 20 words
  Must be specific: names, dates, amounts from the conversation.
  Mila CANNOT act autonomously between briefs. NEVER promise to "track", "monitor", "follow up later".
- what_cp_wants: one sentence summarizing what the CP is requesting/expecting
- weight: 1-10 immovability (1=easy to reschedule, 10=hard to move). immovable=true only for absolutely immovable events.
- venue_index: Pick which address from the FACTS list is the MEETING VENUE (where people will physically meet). Answer with the index number, or null if none apply or no addresses listed. Do NOT pick a property/deal subject unless the meeting is literally AT that property (e.g. a viewing).
- time_index: Pick which proposed time from the FACTS list is relevant. Answer with the index number, or null if none apply or no times listed.
- urgency_category: Based on the URGENCY SIGNAL from enrichment facts above:
  CRITICAL = Must act within hours. Hard deadline today/tomorrow with stated consequence.
  TODAY = Must act by end of business today or tomorrow. Hard deadline this week.
  THIS_WEEK = Must act within the week. Soft deadline or approaching date.
  SOON = Within 2 weeks, no hard deadline visible.
  NONE = No time pressure detected.

Respond with ONLY valid JSON:
{
  "needs_action": true | false,
  "reasoning": "Why this decision (1-2 sentences)",
  "confidence": 0.0-1.0,
  "revisit_at": "YYYY-MM-DD" | null,
  "revisit_reason": "string" | null,
  "action": {
    "type": "REPLY" | "SCHEDULE" | "TODO",
    "intent_cs": "...",
    "rationale_cs": "One sentence: why this action is needed now",
    "urgency_category": "CRITICAL" | "TODAY" | "THIS_WEEK" | "SOON" | "NONE",
    "urgency_justification": "Evidence from message",
    "what_cp_wants": "What the CP is requesting",
    "venue_index": 0 | 1 | null,
    "time_index": 0 | 1 | null,
    "deal_type": "sale" | "purchase" | "rental" | "lease" | "consultation" | "other" | null,
    "weight": 1-10,
    "immovable": false,
    "missing_info": [{"label": "Full question in ${lang}", "value": null}]
  },
  "secondary_action": null | { same shape as action }
}

If needs_action is false, omit the action and secondary_action fields entirely.

CRITICAL: All user-facing text (intent_cs, rationale_cs, what_cp_wants, missing_info labels, reasoning, revisit_reason) must be in ${lang}. Do not output English.`

  const raw = await runAITask('triage', prompt)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse triage result')

  const parsed = JSON.parse(jsonMatch[0])

  // Validate and coerce
  const result: TriageResult = {
    needs_action: parsed.needs_action === true,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
    revisit_at: null,
    revisit_reason: typeof parsed.revisit_reason === 'string' ? parsed.revisit_reason : null,
  }

  // Validate revisit_at
  if (typeof parsed.revisit_at === 'string' && parsed.revisit_at) {
    const dateMatch = parsed.revisit_at.match(/^\d{4}-\d{2}-\d{2}$/)
    if (dateMatch) {
      const revisitDate = new Date(parsed.revisit_at + 'T00:00:00')
      if (!isNaN(revisitDate.getTime()) && revisitDate > now) {
        result.revisit_at = parsed.revisit_at
      } else {
        console.warn(`[Triage] revisit_at "${parsed.revisit_at}" is in the past or invalid, ignoring`)
      }
    } else {
      console.warn(`[Triage] revisit_at "${parsed.revisit_at}" is malformed, ignoring`)
    }
  }

  if (result.needs_action && parsed.action) {
    result.action = coerceTriageAction(parsed.action)
    if (parsed.secondary_action && typeof parsed.secondary_action === 'object') {
      result.secondary_action = coerceTriageAction(parsed.secondary_action)
    }
  }

  return result
}

function coerceTriageAction(raw: Record<string, unknown>): TriageAction {
  const validCategories = ['CRITICAL', 'TODAY', 'THIS_WEEK', 'SOON', 'NONE'] as const
  const rawCat = typeof raw.urgency_category === 'string' ? raw.urgency_category.toUpperCase() : 'NONE'
  const urgency_category = validCategories.includes(rawCat as typeof validCategories[number])
    ? (rawCat as typeof validCategories[number])
    : 'NONE'

  return {
    type: (raw.type as ActionType) || 'REPLY',
    intent_cs: typeof raw.intent_cs === 'string' ? raw.intent_cs : '',
    rationale_cs: typeof raw.rationale_cs === 'string' ? raw.rationale_cs : '',
    urgency_category,
    urgency_justification: typeof raw.urgency_justification === 'string' ? raw.urgency_justification : '',
    what_cp_wants: typeof raw.what_cp_wants === 'string' ? raw.what_cp_wants : '',
    venue_index: typeof raw.venue_index === 'number' ? raw.venue_index : null,
    time_index: typeof raw.time_index === 'number' ? raw.time_index : null,
    deal_type: typeof raw.deal_type === 'string' ? (raw.deal_type as DealType) : null,
    weight: typeof raw.weight === 'number' ? raw.weight : 1,
    immovable: raw.immovable === true,
    missing_info: Array.isArray(raw.missing_info) ? raw.missing_info : [],
  }
}

// ─── Triage verification ───────────────────────────────────────────────────

export interface VerifyResult {
  action_justified: boolean
}

/**
 * Cross-check triage result against the original message.
 * Single question: is this action justified, or is it just an FYI/confirmation?
 * Stage: triage_verify (gemini-2.5-flash-lite → claude-haiku)
 */
export async function verifyTriage(
  latestInboundText: string,
  triage: TriageResult,
  _settings: UserSettings,
): Promise<VerifyResult> {
  console.log(`[AI:verifyTriage] Running stage 'triage_verify'`)
  const action = triage.action!

  const prompt = `Does this message contain a NEW REQUEST requiring user action, or is it just an acknowledgment/FYI/confirmation/thank-you?

ORIGINAL MESSAGE:
${latestInboundText.slice(0, 2000)}

TRIAGE DECISION:
- type: ${action.type}
- intent: ${action.intent_cs}
- what CP wants: ${action.what_cp_wants}

Is this a new request requiring action? Respond with ONLY valid JSON:
{"action_justified": true/false}`

  const raw = await runAITask('triage_verify', prompt)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.warn('[Triage:verify] Failed to parse verification, trusting triage as-is')
    return { action_justified: true }
  }

  const parsed = JSON.parse(jsonMatch[0])
  return {
    action_justified: parsed.action_justified !== false,
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
