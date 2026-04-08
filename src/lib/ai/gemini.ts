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
  immovable?: boolean
  dealType: DealType
  suggestedLocation?: string | null
  locationConfidence?: 'high' | 'low' | null
  suggestedTime?: string | null
  meetingType?: 'address' | 'online' | 'phone'
  cpPhone?: string | null
}

export async function proposeAction(
  conversationSummary: ConversationSummary,
  recentMessages: { direction: string; text: string }[],
  cpName: string | null,
  settings: UserSettings,
  channel: 'email' | 'whatsapp' = 'email',
  journalText: string = '',
  enrichedText: string = ''
): Promise<ProposedAction[]> {
  const planningLang = settings.ai_language || 'Czech'
  console.log(`[AI:proposeAction] Running stage 'planning' for ${cpName || 'unknown CP'}`)
  // Planning.ts already caps messages at ~2000 chars of enriched text.
  // Do NOT truncate further — enriched text contains structured extractions
  // (Adresa:, Navrhovaný čas:, etc.) that get destroyed by slicing.
  const recentText = recentMessages
    .map(m => `[${m.direction}]: ${m.text}`)
    .join('\n\n')

  const systemContext = getAISystemPrompt(settings, { excludeLawyerNotary: true })
  const channelNote = channel === 'whatsapp'
    ? 'CHANNEL: WhatsApp — keep messages short, informal, no subject line needed.'
    : 'CHANNEL: Email — standard professional format.'

  // Check if conversation contains high-value signals
  const conversationText = recentMessages.map(m => m.text).join(' ')
  const isHighValue = containsHighValueSignals(conversationText, settings)
  const highValueNote = isHighValue
    ? 'HIGH-VALUE DEAL DETECTED — this conversation matches high-value signals. Prioritize accordingly and estimate dollar value carefully.'
    : ''

  const now = new Date()
  const tz = settings.timezone || 'Europe/Prague'
  const todayStr = now.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz })
  const timeStr = now.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const isoDate = now.toISOString().split('T')[0]

  const prompt = `${systemContext}

${channelNote}
${highValueNote}

TODAY'S DATE: ${todayStr} (${isoDate}), current time: ${timeStr}, timezone: ${tz}
Use this to resolve relative dates: "tomorrow" = ${new Date(now.getTime() + 86400000).toISOString().split('T')[0]}, "next week" = week of ${new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0]}.

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
${journalText ? `\nMILA'S NOTES (accumulated beliefs about this CP/deal):\n${journalText}` : ''}${enrichedText ? `\nENRICHED DATA (structured fields from latest message):\n${enrichedText}` : ''}

CONVERSATION-FIRST REASONING:
A conversation may span multiple CPs, email threads, and channels (email + WhatsApp) — but it represents ONE deal or relationship. The recent messages below are raw inputs that update the conversation state. Do NOT treat them as separate items needing separate actions.
Your job: (1) Understand HOW we got here — the arc of the conversation so far (use CONVERSATION STATE above). (2) Assess WHERE things stand RIGHT NOW. (3) Decide WHAT the user needs to do next. Focus your rationale_cs on the current situation and why action is needed now, not on summarizing individual messages.

ACTION TYPE RULES — return one OR multiple actions only when genuinely independent tasks exist:
1. REPLY — the user needs to send a message that is NOT related to any meeting or scheduling. Only use REPLY when there is NO meeting/viewing/appointment being discussed.
2. SCHEDULE — use this whenever a meeting, viewing, appointment, or in-person event is involved. This includes:
   - CP confirmed a specific time → SCHEDULE (create event + send invite)
   - CP proposed a specific time → SCHEDULE (create event + send invite)
   - CP wants to meet but no time yet → SCHEDULE (find slot + send invite)
   - CP asks to sign a contract in person → SCHEDULE (that's a meeting)
   CRITICAL — suggestedTime: This MUST be the time of the ACTUAL MEETING with the CP. If CP says "meeting at 9:00" → suggestedTime = 9:00. If CP says "let's meet tomorrow afternoon" → suggestedTime = tomorrow 14:00 (your best interpretation). NEVER schedule a separate time slot to "send the invitation" or "confirm the meeting" — clicking UDĚLAT sends the invite automatically. If user needs prep time before the meeting, that is a separate TODO, not a second SCHEDULE.
   CRITICAL — invite is the reply: The calendar invite body IS the reply to the counterparty. When user clicks UDĚLAT, Mila sends the calendar invite which serves as the confirmation email. So intent_cs must describe BOTH what the reply will say AND what meeting is being booked. Example: "Potvrdím účast na podpisu zítra v 9:00 u notáře, zodpovím dotaz ohledně dokumentů a zablokuji čas ve vašem kalendáři. Klikněte UDĚLAT." There is NEVER a separate REPLY when a SCHEDULE exists. The invite handles ALL communication about the meeting.
3. TODO — something the user needs to do themselves that is NOT a message and NOT a meeting. Examples: gather documents, review a contract internally, get banker approval, verify an address, prepare specific paperwork. Be CONCRETE — list each specific task (e.g. "Získejte souhlas od banky" not "Připravte dokumenty"). NEVER use TODO when the CP proposed a meeting — that is SCHEDULE. NEVER use TODO when the next step is responding to the CP — that is REPLY or SCHEDULE.
   CRITICAL: Mila CANNOT act autonomously between briefs. NEVER promise to "track", "monitor", "follow up", "send later", or "call if no reply". Mila proposes actions — the user decides and acts. If something is time-sensitive, set urgency accordingly so instant notifications alert the user.
4. SCHEDULE ABSORBS REPLY: When a SCHEDULE action exists, do NOT return a REPLY action for the same conversation. The calendar invite is the reply. Any CP questions get answered in the invite body. This is absolute — no exceptions.
5. You MUST always return at least one action based on the current conversation state.
6. Each action is independent — different urgency, weight, and intent for each.
7. DEDUP RULE: Never return two actions that accomplish the same thing. If a SCHEDULE already confirms a meeting with the CP, do NOT add a REPLY. If a REPLY already covers everything, do NOT add a TODO that just says "follow up on the reply." Each action must address a genuinely INDEPENDENT task.

MULTI-ACTION TRIAGE:
When a conversation requires multiple steps, think through the critical path the way a human assistant would:
- What must happen FIRST or the deal is lost? (confirm, reply, lock in the appointment)
- What meeting needs to be booked — at what ACTUAL time, at what ACTUAL location?
- What does the user need to prepare BEFORE the meeting? (documents, approvals, external confirmations)
Return a separate action for each genuinely independent step. Each gets its own urgency based on ITS OWN deadline.

CRITICAL — MEETING TIME = DEADLINE FOR PREP:
A proposed or confirmed meeting time IS a deadline for any action that must happen before that meeting. If a call is scheduled for "zítra v 9:00", then a TODO to prepare for that call has a deadline of TOMORROW → urgency 9. If a notary signing is "zítra v 9:00" and documents must be ready by 8:30, the TODO to gather documents has a deadline of TOMORROW → urgency 9. This applies to any action that is causally dependent on the meeting — prep tasks, document gathering, approvals needed before the meeting. It does NOT apply to unrelated actions that happen to be in the same conversation.

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

Respond with ONLY valid JSON — an array of one or more action objects:
[{
  "actionType": "REPLY" | "SCHEDULE" | "TODO",
  "rationale_cs": "One sentence in ${planningLang}: the BUSINESS REASON this action is needed NOW. Focus on consequences, deadlines, or relationship risk. NEVER repeat what intent_cs says.",
  "intent_cs": "PROACTIVE description in ${planningLang}: what Mila HAS ALREADY DONE + what she WILL DO when user clicks UDĚLAT. Must contain SPECIFIC data from the conversation (names, dates, amounts, locations). For TODO: describe the concrete task the user must do themselves. NEVER repeat what rationale_cs says.",
  "missingInfo": [{"label": "FULL question in ${planningLang}", "value": null}],
  "urgencyJustification": "Before assigning urgency: state today's date, state the deadline language found (quote exact words from the conversation), calculate how many hours/days remain. If no deadline language exists, write 'No deadline language found.' Write this reasoning BEFORE deciding the number.",
  "urgency": 1-10 (see URGENCY RULES below — assign this AFTER writing urgencyJustification above),
  "dollarValue": estimated deal value in ${settings.typical_deal_size_currency} (0 if unknown, use range ${settings.typical_deal_size_min.toLocaleString()}-${settings.typical_deal_size_max.toLocaleString()} as reference),
  "weight": 1-10 (how immovable is this? 1 = easy to reschedule, 10 = hard to move. Use 100 ONLY for absolutely immovable commitments like court dates, kids events, airport pickups),
  "dealType": "sale" | "purchase" | "rental" | "lease" | "consultation" | "other" | null (classify the nature of this deal/conversation),
  "meetingType": "'address' for in-person meetings (viewings, office meetings, notary). 'online' for video calls (Google Meet). 'phone' for phone calls — when the conversation suggests a quick call, phone discussion, or someone says 'zavolám vám' / 'můžeme si zavolat' / 'call me'. Default to 'address' for SCHEDULE actions unless the conversation clearly indicates a call or video meeting.",
  "cpPhone": "Counterparty's phone number if found in the conversation (from signature, message text, or WhatsApp). Format: international with + prefix (e.g. '+420123456789'). null if not found. Important for phone meetings.",
  "suggestedLocation": "Physical address WHERE PEOPLE WILL MEET — the meeting venue, NOT the property or deal subject. Only relevant when meetingType is 'address'. Priority: (1) explicit venue ('meet at Dykova 17', 'come to our office'), (2) CP's office address from signature IF meeting is at their place, (3) user's office address (see system context) if CP says 'at your office' or 'come to you', (4) the property address ONLY if the meeting is literally at the property (e.g. a viewing/inspection). Addresses in email signatures are the SENDER's company address — do not confuse with meeting venue. A conversation about 'office space in Karlin' does NOT mean the meeting is in Karlin. null if no meeting venue clues exist or meetingType is not 'address'.",
  "locationConfidence": "'high' if venue is explicitly stated or clearly implied ('meet at your office', 'come to Dykova 17'). 'low' if inferring from weak signals (signature address without meeting-place context). null if suggestedLocation is null.",
  "suggestedTime": "ISO 8601 datetime if counterparty or user proposed a specific time (e.g. '2025-02-12T09:30:00'). If the enriched messages contain 'Navrhovaný čas' with a specific day+time, you MUST convert it to ISO 8601 and put it here. Do NOT leave null when a specific time is stated. null ONLY if no specific time mentioned. CRITICAL: If the CP explicitly stated a time (even outside working hours or on weekends), extract it exactly as stated. But if YOU are generating a suggested time and the CP did NOT state one, you MUST respect the user's working hours and working days from the system context. Do NOT suggest weekends or evenings unless the CP explicitly requested them.",
  "cpAvailability": "Free-text string describing when the CP said they're available (e.g. 'Tuesday afternoon', 'next week except Wednesday'). null if not mentioned."
}]

Rules:
- DO NOT write the email draft.
- For SCHEDULE: intent_cs describes what Mila will schedule. missingInfo should contain any questions the CP asked that need answering in the calendar invite (e.g. parking, documents, who's coming). Only LEAVE OUT time/slot logistics — scheduling handles those automatically.
- ADDRESS INFERENCE for SCHEDULE: suggestedLocation is the MEETING VENUE — where people will physically meet. It is NOT the property/deal subject unless the meeting is at the property (e.g. a viewing). Priority: (1) explicit venue stated in conversation, (2) CP's office from their signature if meeting is at their place, (3) user's office (from system context) if CP says 'at your office', (4) property address only for viewings/inspections. A conversation about 'office space in Karlin' does NOT mean the meeting is in Karlin. If you only have a partial address, output it — Google Maps can often resolve it. Set locationConfidence to 'low' when the source is ambiguous.
- For REPLY: intent_cs describes the email content Mila will prepare. missingInfo should contain questions CP asked.
- For TODO: intent_cs describes what the user needs to do. No draft needed.
- missingInfo: Extract ALL specific questions the counterparty asked. The label MUST be the COMPLETE question in ${planningLang}. Do NOT shorten to keywords.
- Each action in the array is independent — urgency, weight, dollarValue can differ per action.

CRITICAL: You must generate ALL user-facing text (rationale_cs, intent_cs, missingInfo labels) in ${planningLang}. Do not output English.

CRITICAL — URGENCY RULES (MUST FOLLOW EXACTLY):
CRITICAL: Write urgencyJustification FIRST. State the facts. Then assign the urgency number. Never assign the number before reasoning through the evidence.
Urgency is based ONLY on deadline language explicitly stated in the conversation OR on a proposed/confirmed meeting time that creates a preparation deadline (see MEETING TIME = DEADLINE FOR PREP above). Do NOT infer urgency from deal size, importance, or your own judgment about what "should" be urgent.

Scale:
  10 = HARD deadline TODAY (explicit: "dnes", "today", "do 17:00")
  9 = HARD deadline TOMORROW (explicit: "zítra", "tomorrow")
  7-8 = HARD deadline THIS WEEK with a SPECIFIC DAY named ("do pátku", "ve středu") or stated consequence ("jinak odstoupím")
  5 = SOFT time reference ("tento týden", "brzy", "v nejbližších dnech") — NO specific day, NO consequence
  3-4 = Within 2-4 weeks ("příští měsíc", "do konce dubna", "v průběhu příštích týdnů")
  2 = DEFAULT. Use this when NO deadline language exists in the conversation AT ALL.
  1 = Explicitly stated no rush ("žádný spěch", "není kam spěchat", "no rush")

HARD RULES:
- If the conversation contains "žádný spěch", "no rush", or equivalent → urgency MUST be 1. No exceptions.
- If there is NO deadline language at all → urgency MUST be 2. Not 3, not 5, not 7. Exactly 2.
- urgency 7+ requires a HARD DEADLINE with a specific date/day or stated consequence.
- "do dubna" when today is late March = urgency 3-4 (weeks away), NOT 9-10.
- A large deal value does NOT increase urgency. A 45M deal with no deadline is urgency 2.`

  const text = await runAITask('planning', prompt)

  // Parse array or single object (backward safe)
  let actions: ProposedAction[]
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    const parsed = JSON.parse(arrayMatch[0])
    actions = Array.isArray(parsed) ? parsed : [parsed]
  } else {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('Failed to parse action proposal')
    actions = [JSON.parse(jsonMatch[0])]
  }

  // DISABLED 2026-04-08: urgency_review was over-correcting valid urgency assessments.
  // Root cause: review rejects valid deadline reasoning as "fabricated quotes" and ignores
  // sibling inheritance rules. Haiku's urgency assessment has improved after prompt changes
  // (urgencyJustification-before-number, meeting-deadline rules). Re-enable only after
  // adding e2e assertions that verify both pre-review and post-review urgency values.
  //
  // const needsReview = actions.some(a => (a.urgency || 0) >= 5)
  // if (needsReview) {
  //   try {
  //     actions = await reviewUrgency(actions, recentText)
  //   } catch (e) {
  //     console.error('[Planning] Urgency review failed, using original values:', e)
  //   }
  // }

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
  // Review ALL actions when any action has urgency >= 5.
  // Low-urgency siblings that should be high are the most dangerous errors
  // (e.g., a TODO at urgency=2 that's actually prep for a tomorrow meeting).
  const anyHighUrgency = actions.some(a => (a.urgency || 0) >= 5)
  if (!anyHighUrgency) return actions

  const actionsToReview = actions
    .map((a, i) => ({ index: i, urgency: a.urgency || 0, justification: (a as Record<string, unknown>).urgencyJustification || '' }))

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
- A proposed/confirmed meeting time IS a deadline for prep tasks. If a meeting is "zítra v 9:00", a TODO to prepare documents for that meeting has a deadline of TOMORROW → urgency 9. Only applies to actions causally dependent on the meeting — not unrelated actions.
- "do konce dubna" when today is late March = 3-4 (weeks away), NOT 7+
- Deal importance, relationship importance, or dollar value do NOT increase urgency
- If the justification quotes words not actually present in the conversation, lower urgency to 2

CONVERSATION TEXT:
${conversationText.slice(0, 3000)}

SIBLING ACTIONS (same conversation):
${actions.map((a, i) => `Action ${i}: ${a.actionType} urgency=${a.urgency}`).join('\n')}

If a TODO is required before a sibling SCHEDULE, it inherits that SCHEDULE's urgency. Do not lower it below the sibling SCHEDULE's urgency.

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
