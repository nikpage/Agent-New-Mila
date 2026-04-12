# Refactor: Feed Enrichment Into Triage — Detailed Instructions

## Goal
Stop triage from re-extracting facts that enrichment already extracted. Triage becomes a judgment-only prompt that picks from enrichment lists instead of generating from scratch. Programmatic gates replace AI verification for factual fields.

## Files Changed
1. `src/lib/ai/gemini.ts` — triage prompt, TriageAction interface, verifyTriage
2. `src/services/planning.ts` — parse enrichment, pass to triage, code gates, urgency mapping
3. `src/lib/ai/context.ts` — no changes needed (already has parseEnrichedText, formatEnrichedForPrompt)

## Pre-Conditions
- Run `npm test && npm run build` before starting. All tests must pass.
- Read all three files completely before making any edits.

---

## Step 1: Update TriageAction interface and triage prompt (gemini.ts)

### 1a. Change TriageAction interface

Replace the current `TriageAction` interface (around line 284) with:

```typescript
export interface TriageAction {
  type: ActionType
  intent_cs: string
  rationale_cs: string
  urgency_category: 'CRITICAL' | 'TODAY' | 'THIS_WEEK' | 'SOON' | 'NONE'
  urgency_justification: string
  what_cp_wants: string
  venue_index: number | null       // index into enrichment addresses[], or null
  time_index: number | null        // index into enrichment proposedTimes[], or null
  deal_type: DealType | null
  weight: number
  immovable: boolean
  missing_info: { label: string; value: null }[]
}
```

Fields REMOVED from TriageAction (will be resolved by code in planning.ts):
- `meeting_venue` (string) — replaced by `venue_index` (number)
- `meeting_venue_source` (string) — no longer needed
- `meeting_venue_confidence` ('high'|'low') — no longer needed
- `proposed_time` (string) — replaced by `time_index` (number)
- `meeting_type` (string) — will come from enrichment
- `dollar_value` (number) — will come from enrichment
- `cp_phone` (string) — will come from CP record
- `urgency` (number) — replaced by `urgency_category` (string), code maps to number

### 1b. Update coerceTriageAction function

Replace the current `coerceTriageAction` function (around line 500) to match the new interface:

```typescript
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
```

### 1c. Add enrichment parameter to triageConversation

Change the `triageConversation` function signature to accept enrichment data. Add a new parameter after `journalText`:

```typescript
export async function triageConversation(
  latestInboundText: string,
  recentMessages: { direction: string; text: string; age: string }[],
  summary: ConversationSummary | null,
  pendingActions: { type: string; intent: string; urgency: number }[],
  cpName: string,
  channel: 'email' | 'whatsapp',
  settings: UserSettings,
  journalText: string,
  enrichment: EnrichedMessageData | null,  // NEW PARAMETER
): Promise<TriageResult> {
```

Import `EnrichedMessageData` is already available — it's defined in the same file.

### 1d. Build the FACTS FROM ENRICHMENT block in the triage prompt

Inside `triageConversation`, after the existing variable declarations (todayStr, isoDate, etc.) and before building the prompt string, add:

```typescript
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
```

### 1e. Rewrite the triage prompt

Replace the entire prompt template string (the `const prompt = ...` assignment) with the version below. The key differences:
- Adds `${enrichmentBlock}` block
- Removes all address/venue extraction instructions
- Replaces urgency 1-10 scale with 5 categories
- Replaces free-text venue/time with pick-from-list indices
- Removes cp_phone, meeting_venue_source, meeting_venue_confidence, dollar_value, meeting_type from output
- Output fields go from ~22 to ~13

```typescript
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
```

### 1f. Slim down verifyTriage

Replace the `verifyTriage` function. It now asks only ONE question: is the action justified?

```typescript
/**
 * Cross-check triage result against the original message.
 * Single question: is this action justified, or is it just an FYI/confirmation?
 * Stage: triage_verify (gemini-2.5-flash-lite → claude-haiku)
 */
export async function verifyTriage(
  latestInboundText: string,
  triage: TriageResult,
  _settings: UserSettings,
): Promise<{ action_justified: boolean }> {
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
```

Also update the `VerifyResult` interface:

```typescript
export interface VerifyResult {
  action_justified: boolean
}
```

---

## Step 2: Update planning.ts — parse enrichment, code gates, urgency mapping

### 2a. Add imports

At the top of planning.ts, add:

```typescript
import { parseEnrichedText, type EnrichedMessageData } from '@/lib/ai/gemini'
```

`parseEnrichedText` is already exported from gemini.ts.

### 2b. Add urgency mapping function

Add this function near the top of planning.ts, after the imports and before `validateMeetingLocation`:

```typescript
/**
 * Map urgency category + enrichment urgency signal to a 1-10 number.
 * The AI picks a coarse category (5 levels). Code maps to the specific number
 * using the enrichment's urgency classification as a fine-grained selector.
 */
function mapUrgencyToNumber(
  category: 'CRITICAL' | 'TODAY' | 'THIS_WEEK' | 'SOON' | 'NONE',
  enrichmentSignal: 'HARD DEADLINE' | 'SOFT REFERENCE' | null
): number {
  // Each category has a range. Signal picks within the range:
  // HARD DEADLINE → top, SOFT REFERENCE → middle, null → bottom
  const ranges: Record<string, [number, number, number]> = {
    CRITICAL: [9, 9, 10],    // null=9, soft=9, hard=10
    TODAY:    [7, 7, 8],     // null=7, soft=7, hard=8
    THIS_WEEK: [5, 5, 6],   // null=5, soft=5, hard=6
    SOON:    [3, 3, 4],      // null=3, soft=3, hard=4
    NONE:    [1, 1, 2],      // null=1, soft=1, hard=2
  }
  const range = ranges[category] || ranges.NONE
  if (enrichmentSignal === 'HARD DEADLINE') return range[2]
  if (enrichmentSignal === 'SOFT REFERENCE') return range[1]
  return range[0]
}
```

### 2c. Parse enrichment and pass to triage

In `generateActionProposal`, after the existing code that finds `latestInboundMsg` and `latestInboundText` (around line 106-109), add:

```typescript
// Parse enrichment data from latest inbound message
const enrichment: EnrichedMessageData | null = latestInboundMsg?.enriched_text
  ? parseEnrichedText(latestInboundMsg.enriched_text)
  : null
```

Then update the `triageConversation` call (around line 132) to pass `enrichment`:

```typescript
const triageResult = await triageConversation(
  latestInboundText,
  formattedMessages,
  summary,
  pendingForPrompt,
  cp.name || cp.primary_identifier || 'Unknown',
  channel,
  settings,
  journalText,
  enrichment,  // NEW — pass enrichment data
)
```

### 2d. Replace AI verification with code gates + slim verify

Replace the entire verification block (from `const verifyResult = await verifyTriage(...)` through the venue rejection block, approximately lines 161-177) with:

```typescript
// ─── CODE GATES: validate triage output against enrichment ──────────
if (triageResult.action) {
  const ta = triageResult.action

  // Gate 1: Resolve venue_index → address string
  if (ta.venue_index !== null && enrichment?.addresses?.length) {
    if (ta.venue_index >= 0 && ta.venue_index < enrichment.addresses.length) {
      // Valid index — will be used in SCHEDULE payload below
    } else {
      console.log(`[Planning] venue_index ${ta.venue_index} out of range (${enrichment.addresses.length} addresses), setting null`)
      ta.venue_index = null
    }
  } else if (ta.venue_index !== null) {
    // Index given but no enrichment addresses — invalid
    ta.venue_index = null
  }

  // Gate 2: Resolve time_index → proposed time
  if (ta.time_index !== null && enrichment?.proposedTimes?.length) {
    if (ta.time_index >= 0 && ta.time_index < enrichment.proposedTimes.length) {
      // Valid index — will be resolved below
    } else {
      console.log(`[Planning] time_index ${ta.time_index} out of range (${enrichment.proposedTimes.length} times), setting null`)
      ta.time_index = null
    }
  } else if (ta.time_index !== null) {
    ta.time_index = null
  }

  // Gate 3: dollar_value from enrichment (parse price string to number)
  let dollarValue = 0
  if (enrichment?.keyNumbers?.price) {
    const priceStr = enrichment.keyNumbers.price.replace(/[^\d.,]/g, '').replace(',', '.')
    const parsed = parseFloat(priceStr)
    if (!isNaN(parsed) && parsed >= 0) {
      dollarValue = parsed
      // Sanity check: cap at 10x typical max
      if (dollarValue > settings.typical_deal_size_max * 10) {
        console.log(`[Planning] dollar_value ${dollarValue} exceeds 10x max, capping`)
        dollarValue = settings.typical_deal_size_max * 10
      }
    }
  }

  // Gate 4: intent_cs word count check
  if (ta.type === 'REPLY' || ta.type === 'SCHEDULE') {
    const wordCount = ta.intent_cs.split(/\s+/).length
    if (wordCount > 25) {
      ta.intent_cs = ta.intent_cs.split(/\s+/).slice(0, 20).join(' ')
      console.log(`[Planning] intent_cs truncated from ${wordCount} to 20 words`)
    }
  }

  // Store resolved values for use in action creation
  ;(ta as Record<string, unknown>)._resolved_dollar_value = dollarValue
  ;(ta as Record<string, unknown>)._resolved_meeting_venue = ta.venue_index !== null && enrichment?.addresses
    ? enrichment.addresses[ta.venue_index] : null
  ;(ta as Record<string, unknown>)._resolved_proposed_time = ta.time_index !== null && enrichment?.proposedTimes
    ? enrichment.proposedTimes[ta.time_index] : null
  ;(ta as Record<string, unknown>)._resolved_meeting_type = enrichment?.meetingType || null
}

// Also gate secondary_action if present
if (triageResult.secondary_action) {
  const sa = triageResult.secondary_action
  if (sa.venue_index !== null) {
    if (!enrichment?.addresses?.length || sa.venue_index < 0 || sa.venue_index >= enrichment.addresses.length) {
      sa.venue_index = null
    }
  }
  if (sa.time_index !== null) {
    if (!enrichment?.proposedTimes?.length || sa.time_index < 0 || sa.time_index >= enrichment.proposedTimes.length) {
      sa.time_index = null
    }
  }
  let secDollarValue = 0
  if (enrichment?.keyNumbers?.price) {
    const priceStr = enrichment.keyNumbers.price.replace(/[^\d.,]/g, '').replace(',', '.')
    const parsed = parseFloat(priceStr)
    if (!isNaN(parsed) && parsed >= 0) secDollarValue = parsed
  }
  ;(sa as Record<string, unknown>)._resolved_dollar_value = secDollarValue
  ;(sa as Record<string, unknown>)._resolved_meeting_venue = sa.venue_index !== null && enrichment?.addresses
    ? enrichment.addresses[sa.venue_index] : null
  ;(sa as Record<string, unknown>)._resolved_proposed_time = sa.time_index !== null && enrichment?.proposedTimes
    ? enrichment.proposedTimes[sa.time_index] : null
  ;(sa as Record<string, unknown>)._resolved_meeting_type = enrichment?.meetingType || null
}

// ─── VERIFY: only check action justification (slim AI call) ─────────
const verifyResult = await verifyTriage(latestInboundText, triageResult, settings)

if (!verifyResult.action_justified) {
  console.log(`[Planning] Verification: action not justified for ${cp.name || cp.primary_identifier}, skipping`)
  return []
}
```

### 2e. Update the action creation loop to use resolved values

In the `for (const ta of triageActions)` loop, the code currently reads `ta.dollar_value`, `ta.meeting_venue`, `ta.proposed_time`, `ta.meeting_type`, `ta.meeting_venue_confidence`, `ta.cp_phone`. These fields no longer exist on TriageAction. Replace with resolved values.

At the top of the loop body (after the `seenTypes` check), add:

```typescript
const resolved = ta as Record<string, unknown>
const resolvedDollarValue = (resolved._resolved_dollar_value as number) || 0
const resolvedMeetingVenue = (resolved._resolved_meeting_venue as string) || null
const resolvedProposedTime = resolved._resolved_proposed_time as { original: string; interpreted: string; specificDate?: string; timeOfDay?: string; relativeRef?: string; dayOfWeek?: string; eventContext?: string } | null
const resolvedMeetingType = (resolved._resolved_meeting_type as string) || null

// Map urgency category to number
const enrichmentSignal = enrichment?.urgency?.classification as 'HARD DEADLINE' | 'SOFT REFERENCE' | null ?? null
const resolvedUrgency = mapUrgencyToNumber(ta.urgency_category, enrichmentSignal)
```

Then update every reference in the loop:
- `ta.dollar_value` → `resolvedDollarValue`
- `ta.urgency` → `resolvedUrgency`
- `ta.meeting_venue` → `resolvedMeetingVenue`
- `ta.meeting_venue_confidence` → remove (no longer exists)
- `ta.proposed_time` → resolve to ISO string from `resolvedProposedTime`
- `ta.meeting_type` → `resolvedMeetingType`
- `ta.cp_phone` → `null` (will be fetched from CP record if needed downstream)

### 2f. Update the SCHEDULE payload block

Replace the SCHEDULE payload block (around lines 230-288) with:

```typescript
let schedulingPayload: Record<string, unknown> = {}
if (ta.type === 'SCHEDULE') {
  const proposedMeetingType = resolvedMeetingType || 'address'
  const isRemoteMeeting = proposedMeetingType === 'phone' || proposedMeetingType === 'online'

  let meetingLocation: string | undefined
  if (!isRemoteMeeting) {
    if (resolvedMeetingVenue) {
      meetingLocation = resolvedMeetingVenue
    } else if (cp.locations) {
      const locations = cp.locations as unknown
      if (Array.isArray(locations) && locations.length > 0 && typeof locations[0] === 'string') {
        meetingLocation = locations[0]
      } else if (typeof locations === 'string') {
        meetingLocation = locations
      }
    }
  }

  // Geocode
  const tzRegionMap: Record<string, string> = {
    'Europe/Prague': 'cz', 'Europe/Bratislava': 'sk', 'Europe/Berlin': 'de',
    'Europe/Vienna': 'at', 'Europe/Warsaw': 'pl', 'Europe/London': 'gb',
    'Europe/Paris': 'fr', 'Europe/Rome': 'it', 'Europe/Madrid': 'es',
  }
  const geocodeRegion = tzRegionMap[settings.timezone] || undefined
  let locationPartial = false
  if (meetingLocation) {
    const validated = await validateMeetingLocation(meetingLocation, geocodeRegion)
    meetingLocation = validated.location
    locationPartial = validated.needsConfirmation
  }

  // Missing address for in-person meeting
  if (!isRemoteMeeting && !meetingLocation) {
    const hasAddressField = ta.missing_info?.some(f => f.label.toLowerCase().includes('adresa'))
    if (!hasAddressField) {
      ta.missing_info = [
        ...(ta.missing_info || []),
        { label: 'Kde se schůzka koná? (adresa nebo Online)', value: null },
      ]
    }
  }

  // Resolve proposed time to ISO string
  let suggestedTime: string | null = null
  if (resolvedProposedTime) {
    // Build ISO datetime from enrichment's structured time data
    const date = resolvedProposedTime.specificDate || null
    const time = resolvedProposedTime.timeOfDay || null
    if (date && time) {
      suggestedTime = `${date}T${time}:00`
    } else if (date) {
      suggestedTime = `${date}T10:00:00` // default to 10am if no time specified
    }
    // If no specificDate, leave null — scheduling will find a slot
  }

  schedulingPayload = {
    suggestedTime,
    suggestedLocation: meetingLocation || null,
    location_partial: locationPartial,
    cp_availability: null,
    duration: settings.default_meeting_duration,
    meeting_type: proposedMeetingType,
    is_online: proposedMeetingType === 'online',
    cp_phone: null, // populated downstream from CP record if needed
  }
}
```

### 2g. Update priority score calculation

Replace the `weight` and `priorityScore` lines:

```typescript
const weight = ta.immovable ? 100 : (ta.weight || 0)
const priorityScore = calculatePriorityScore({
  dollarValue: resolvedDollarValue,
  urgency: resolvedUrgency,
  daysIgnored,
  sellerMultiplier: offerMultiplier,
  kcHighValue: settings.kc_high_value,
  weight,
})
```

### 2h. Update action creation call

In the `createAction` call, replace references to removed fields:

- `urgency: ta.urgency` → `urgency: resolvedUrgency`
- `dollar_value: ta.dollar_value` → `dollar_value: resolvedDollarValue`
- In `payload.action_metadata`: `urgency: ta.urgency` → `urgency: resolvedUrgency`, `dollar_value: ta.dollar_value` → `dollar_value: resolvedDollarValue`

### 2i. Update the refresh pairs loop

In the `for (const { existingId, existingUrgency, triageAction: ta } of refreshPairs)` loop, replace:

```typescript
const resolved = ta as Record<string, unknown>
const resolvedDollarValue = (resolved._resolved_dollar_value as number) || 0
const enrichmentSignal = enrichment?.urgency?.classification as 'HARD DEADLINE' | 'SOFT REFERENCE' | null ?? null
const resolvedUrgency = mapUrgencyToNumber(ta.urgency_category, enrichmentSignal)
const escalatedUrgency = Math.max(existingUrgency, resolvedUrgency)
await updateAction(existingId, {
  intent_cs: ta.intent_cs,
  rationale_cs: ta.rationale_cs,
  urgency: escalatedUrgency,
  priority_score: calculatePriorityScore({
    dollarValue: resolvedDollarValue,
    urgency: escalatedUrgency,
    daysIgnored,
    sellerMultiplier: offerMultiplier,
    kcHighValue: settings.kc_high_value,
    weight: ta.immovable ? 100 : (ta.weight || 0),
  }),
  dollar_value: resolvedDollarValue,
  updated_at: new Date().toISOString(),
})
```

### 2j. Update the urgent action log line

Replace `ta.urgency` with `resolvedUrgency`:

```typescript
if (resolvedUrgency >= 9) {
  console.log(`[Planning] URGENT action created: urgency=${resolvedUrgency}, type=${ta.type}, cp=${cp.name || cp.primary_identifier}`)
}
```

---

## Step 3: Verify nothing else references removed TriageAction fields

Search the entire codebase for references to the removed fields. These are the only places that should reference TriageAction:

1. `src/lib/ai/gemini.ts` — interface definition + coerceTriageAction + triage prompt (all updated above)
2. `src/services/planning.ts` — generateActionProposal (updated above)
3. Tests — see Step 4

If any other file references `meeting_venue`, `meeting_venue_source`, `meeting_venue_confidence`, `proposed_time`, `dollar_value`, `cp_phone` on a TriageAction, those references need updating. Most likely there are none — these fields are only consumed in planning.ts immediately after triage returns.

Grep for: `TriageAction`, `meeting_venue_source`, `meeting_venue_confidence`, `cp_phone` across the src/ directory to confirm.

---

## Step 4: Update tests

Search for test files that reference `triageConversation`, `verifyTriage`, `TriageAction`, or mock their return values. These tests need the mock return values updated to match the new interface shape.

Key changes in test mocks:
- `urgency: 7` → `urgency_category: 'TODAY'`
- Remove `meeting_venue`, `meeting_venue_source`, `meeting_venue_confidence`, `proposed_time`, `meeting_type`, `dollar_value`, `cp_phone` from mock TriageAction objects
- Add `venue_index: null`, `time_index: null` to mock TriageAction objects
- `verifyTriage` mock return: `{ urgency_ok: true, venue_ok: true, action_justified: true }` → `{ action_justified: true }`

IMPORTANT: Do NOT modify expected values in pinning tests. If a pinning test fails, STOP and report. The pinning test files are listed in CLAUDE.md.

---

## Step 5: Build and test

```bash
npm test && npm run build
```

All 511 tests must pass. If any fail, check whether it's a pinning test (report and stop) or a mock that needs updating (update the mock shape).

---

## What NOT to do

- Do NOT change the enrichment prompt (enrichMessage). It already extracts everything we need.
- Do NOT change the priority formula in calculatePriorityScore. It stays identical.
- Do NOT change the pipeline step order in agent.ts.
- Do NOT add new AI calls. The total is still 2 per conversation (triage + verify), same as before.
- Do NOT create new files except `scripts/eval-triage.ts` (the eval harness) and this doc.
- Do NOT change model assignments in ai-models.ts.
- Do NOT refactor unrelated code. Touch only triage-related code paths.

---

## Step 6: Eval harness — measure before and after (NEW FILE: scripts/eval-triage.ts)

This is the step that breaks the "refactor by vibes" cycle. Every source in the research — Hamel Husain, Eugene Yan, OpenAI Cookbook, Promptfoo, Langfuse — says the same thing: measure before you change, measure after, keep or revert. Without this step, this refactor is indistinguishable from the previous four.

### 6a. Create the eval runner

Create `scripts/eval-triage.ts`. This is NOT a unit test. It's a quality measurement tool that calls the real `triageConversation` function with real AI models against a fixed set of inputs and checks the outputs.

```typescript
/**
 * Triage Eval Harness
 *
 * Runs triageConversation against a labeled dataset of known-correct decisions.
 * Each test case comes from a real bug that was fixed in production.
 *
 * Usage:
 *   npx tsx scripts/eval-triage.ts
 *   npx tsx scripts/eval-triage.ts --case 3    # run single case
 *   npx tsx scripts/eval-triage.ts --json       # machine-readable output
 *
 * Run this BEFORE and AFTER any triage prompt change. If pass rate drops, revert.
 */

import { triageConversation, parseEnrichedText, type EnrichedMessageData } from '../src/lib/ai/gemini'
import type { ConversationSummary, UserSettings } from '../src/lib/supabase/types'

// ─── Minimal settings stub (enough for triage to run) ──────────────────────

const TEST_SETTINGS: UserSettings = {
  client_name: 'Test Agent',
  client_company: 'Test Reality s.r.o.',
  business_specialization: 'residential real estate',
  business_market: 'Prague',
  ai_language: 'Czech',
  ai_tone_user: 'professional and concise',
  ai_tone_cp: 'polite and formal',
  timezone: 'Europe/Prague',
  typical_deal_size_min: 2000000,
  typical_deal_size_max: 15000000,
  typical_deal_size_currency: 'CZK',
  kc_high_value: 5000000,
  office_location: 'Dykova 17, Praha 2',
  home_location: null,
  lawyer_notary: 'JUDr. Procházka, Národní 10, Praha 1',
  offer_multiplier_seller: 1.5,
  offer_multiplier_buyer: 1.0,
  working_hours_start: '08:00',
  working_hours_end: '18:00',
  working_days: [1, 2, 3, 4, 5],
  default_meeting_duration: 60,
  meeting_buffer_minutes: 15,
  high_value_signals: ['exclusive', 'penthouse', 'investiční'],
} as UserSettings  // cast — test doesn't need every field

// ─── Test case type ────────────────────────────────────────────────────────

interface EvalCase {
  id: number
  name: string
  /** Git commit that fixed this bug */
  sourceCommit: string
  /** The latest inbound message text */
  latestInbound: string
  /** Recent message history */
  recentMessages: { direction: string; text: string; age: string }[]
  /** Conversation summary (nullable) */
  summary: ConversationSummary | null
  /** Existing pending actions */
  pendingActions: { type: string; intent: string; urgency: number }[]
  /** CP name */
  cpName: string
  /** Channel */
  channel: 'email' | 'whatsapp'
  /** Enrichment data (as if enrichMessage already ran) */
  enrichment: EnrichedMessageData | null
  /** Journal text */
  journalText: string
  /** Assertions — what the triage MUST produce */
  assert: {
    needs_action?: boolean
    type?: 'REPLY' | 'SCHEDULE' | 'TODO'
    /** Urgency category (new system) */
    urgency_category?: 'CRITICAL' | 'TODAY' | 'THIS_WEEK' | 'SOON' | 'NONE'
    /** venue_index must be this value (null = no venue, number = specific index) */
    venue_index?: number | null
    /** time_index must be this value */
    time_index?: number | null
    /** If true, needs_action must be false */
    no_action?: boolean
    /** Substring that MUST appear in intent_cs */
    intent_contains?: string
    /** Substring that MUST NOT appear in intent_cs */
    intent_not_contains?: string
    /** missing_info must have at most this many items */
    max_missing_info?: number
    /** revisit_at must be set (any date) */
    has_revisit?: boolean
  }
}

// ─── Test cases (each from a real production bug) ──────────────────────────

const EVAL_CASES: EvalCase[] = [
  {
    id: 1,
    name: 'Address in body must be verbatim, not hallucinated',
    sourceCommit: '0100e4f',
    latestInbound: 'Dobrý den, rád bych se podíval na byt na Třinecké 672, Praha 10. Můžeme se domluvit na prohlídku? Děkuji, Jan Novotný',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, rád bych se podíval na byt na Třinecké 672, Praha 10. Můžeme se domluvit na prohlídku? Děkuji, Jan Novotný', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Jan Novotný',
    channel: 'email',
    enrichment: {
      parties: ['Jan Novotný'],
      subject: 'Prohlídka bytu',
      messageType: 'meeting_request',
      coreIntent: 'Žádost o prohlídku bytu na Třinecké 672',
      addresses: ['Třinecká 672, Praha 10'],
      proposedTimes: [],
      meetingType: 'prohlídka bytu',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      venue_index: 0,  // must pick the address from enrichment, not invent one
    },
  },

  {
    id: 2,
    name: 'Hard deadline "potvrďte do 17:00" must produce CRITICAL/TODAY urgency',
    sourceCommit: '0100e4f',
    latestInbound: 'Dobrý den, potřebuji od vás potvrzení rezervace do 17:00 dnes, jinak nabídka propadá. Cena 4 500 000 Kč. S pozdravem, Eva Malá',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, potřebuji od vás potvrzení rezervace do 17:00 dnes, jinak nabídka propadá. Cena 4 500 000 Kč. S pozdravem, Eva Malá', age: 'today' },
    ],
    summary: { currentState: 'Jednání o koupi bytu', risks: [], nextSteps: [], keyPoints: [], confidence: 0.8, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Eva Malá',
    channel: 'email',
    enrichment: {
      parties: ['Eva Malá'],
      subject: 'Potvrzení rezervace',
      coreIntent: 'Požadavek na potvrzení rezervace do 17:00',
      addresses: [],
      proposedTimes: [],
      urgency: { quote: 'potvrďte do 17:00 dnes, jinak nabídka propadá', classification: 'HARD DEADLINE' },
      keyNumbers: { price: '4 500 000 Kč' },
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'REPLY',
      urgency_category: 'CRITICAL',
    },
  },

  {
    id: 3,
    name: 'Confirmation email must NOT produce action',
    sourceCommit: '7081204',
    latestInbound: 'Děkuji, domluveno. Těším se na schůzku v úterý. Hezký den, Pavel',
    recentMessages: [
      { direction: 'outbound', text: 'Pane Pavle, navrhoval bych schůzku v úterý v 10:00 v naší kanceláři. Vyhovuje vám to?', age: '1d ago' },
      { direction: 'inbound', text: 'Děkuji, domluveno. Těším se na schůzku v úterý. Hezký den, Pavel', age: 'today' },
    ],
    summary: { currentState: 'Schůzka domluvena na úterý', risks: [], nextSteps: ['Schůzka v úterý'], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [{ type: 'SCHEDULE', intent: 'Domluvit schůzku s Pavlem', urgency: 5 }],
    cpName: 'Pavel',
    channel: 'email',
    enrichment: {
      parties: ['Pavel'],
      subject: 'Potvrzení schůzky',
      messageType: 'confirmation',
      coreIntent: 'Potvrzení domluvené schůzky',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      no_action: true,
    },
  },

  {
    id: 4,
    name: 'CP asks to confirm AND prepare docs → TODO surfaces first',
    sourceCommit: 'b01f1bc',
    latestInbound: 'Dobrý den, schůzka u notáře je naplánována na čtvrtek v 14:00. Prosím přineste výpis z katastru a ověřenou plnou moc. Adresa: Národní 10, Praha 1.',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, schůzka u notáře je naplánována na čtvrtek v 14:00. Prosím přineste výpis z katastru a ověřenou plnou moc. Adresa: Národní 10, Praha 1.', age: 'today' },
    ],
    summary: { currentState: 'Příprava podpisu u notáře', risks: [], nextSteps: [], keyPoints: [], confidence: 0.8, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'JUDr. Procházka',
    channel: 'email',
    enrichment: {
      parties: ['JUDr. Procházka'],
      subject: 'Schůzka u notáře',
      messageType: 'meeting_request',
      coreIntent: 'Pozvání na podpis u notáře, požadavek na dokumenty',
      addresses: ['Národní 10, Praha 1'],
      proposedTimes: [{ original: 'čtvrtek v 14:00', interpreted: 'čtvrtek 14:00', relativeRef: 'specific_day', dayOfWeek: 'thursday', timeOfDay: '14:00', eventContext: 'notary' }],
      meetingType: 'podpis u notáře',
      urgency: { quote: 'schůzka u notáře je naplánována na čtvrtek', classification: 'HARD DEADLINE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      // Primary action should be SCHEDULE (notary appointment) with secondary TODO (bring documents)
      // OR primary TODO with secondary SCHEDULE — either ordering is acceptable
      // The key assertion: both types should appear
      type: 'SCHEDULE',
    },
  },

  {
    id: 5,
    name: 'Signature address must NOT become meeting venue',
    sourceCommit: '0100e4f',
    latestInbound: 'Dobrý den, mám zájem o prohlídku bytu v Karlíně. Kdy by to šlo? S pozdravem, Marie Dvořáková\n\nRE/MAX Premium\nSokolovská 46/51, Praha 8\ntel: +420 777 123 456',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, mám zájem o prohlídku bytu v Karlíně. Kdy by to šlo? S pozdravem, Marie Dvořáková\n\nRE/MAX Premium\nSokolovská 46/51, Praha 8\ntel: +420 777 123 456', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Marie Dvořáková',
    channel: 'email',
    enrichment: {
      parties: ['Marie Dvořáková'],
      subject: 'Prohlídka bytu v Karlíně',
      messageType: 'meeting_request',
      coreIntent: 'Žádost o prohlídku bytu v Karlíně',
      addresses: ['Sokolovská 46/51, Praha 8'],  // signature address, NOT the viewing venue
      proposedTimes: [],
      meetingType: 'prohlídka bytu',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      venue_index: null,  // Sokolovská is a signature address, not the viewing location. Venue should be null.
    },
  },

  {
    id: 6,
    name: 'missing_info must not interrogate — max 2 items',
    sourceCommit: '862e80a',
    latestInbound: 'Chtěl bych prodat byt. Můžeme se sejít?',
    recentMessages: [
      { direction: 'inbound', text: 'Chtěl bych prodat byt. Můžeme se sejít?', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Tomáš',
    channel: 'whatsapp',
    enrichment: {
      parties: ['Tomáš'],
      subject: 'Prodej bytu',
      messageType: 'meeting_request',
      coreIntent: 'Žádost o schůzku ohledně prodeje bytu',
      addresses: [],
      proposedTimes: [],
      meetingType: 'jednání',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      max_missing_info: 2,  // must not produce 5+ questions
    },
  },

  {
    id: 7,
    name: 'SCHEDULE = confirmation, not TODO',
    sourceCommit: 'b858a4f',
    latestInbound: 'Dobrý den, potvrzuji prohlídku zítra v 15:00 na adrese Vinohradská 25, Praha 2. Těším se, Karel',
    recentMessages: [
      { direction: 'outbound', text: 'Dobrý den pane Karle, nabízím vám prohlídku zítra v 15:00. Vyhovuje?', age: '1d ago' },
      { direction: 'inbound', text: 'Dobrý den, potvrzuji prohlídku zítra v 15:00 na adrese Vinohradská 25, Praha 2. Těším se, Karel', age: 'today' },
    ],
    summary: { currentState: 'Prohlídka domluvena', risks: [], nextSteps: ['Prohlídka'], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Karel',
    channel: 'email',
    enrichment: {
      parties: ['Karel'],
      subject: 'Potvrzení prohlídky',
      messageType: 'confirmation',
      coreIntent: 'Potvrzení prohlídky zítra v 15:00',
      addresses: ['Vinohradská 25, Praha 2'],
      proposedTimes: [{ original: 'zítra v 15:00', interpreted: 'zítra 15:00', relativeRef: 'tomorrow', timeOfDay: '15:00', eventContext: 'viewing' }],
      meetingType: 'prohlídka bytu',
      urgency: { quote: 'zítra v 15:00', classification: 'HARD DEADLINE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',  // NOT TODO — a confirmed viewing is a SCHEDULE
      venue_index: 0,
      time_index: 0,
    },
  },

  {
    id: 8,
    name: 'Draft must not fabricate — intent must reference real content',
    sourceCommit: '58abd9b',
    latestInbound: 'Dobrý den, posílám fotky z bytu. Dám vám vědět o dalších zájemcích. Martin',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, posílám fotky z bytu. Dám vám vědět o dalších zájemcích. Martin', age: 'today' },
    ],
    summary: { currentState: 'Čekáte na fotky a info o zájemcích', risks: [], nextSteps: [], keyPoints: [], confidence: 0.7, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Martin',
    channel: 'email',
    enrichment: {
      parties: ['Martin'],
      subject: 'Fotky z bytu',
      messageType: 'update',
      coreIntent: 'Zaslání fotek, info o dalších zájemcích',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      // This is an FYI update — could go either way (no_action or low-urgency REPLY to thank)
      // Key: if action IS proposed, intent must NOT fabricate requests Martin didn't make
      intent_not_contains: 'potvr',  // must not fabricate "confirm" when Martin didn't ask for confirmation
      max_missing_info: 1,
    },
  },

  {
    id: 9,
    name: '"CP will send contract Monday" → revisit, not action',
    sourceCommit: '7081204',
    latestInbound: 'Dobrý den, smlouvu vám pošlu v pondělí. Hezký víkend, Petra',
    recentMessages: [
      { direction: 'outbound', text: 'Petro, mohla byste mi prosím poslat návrh smlouvy?', age: '2d ago' },
      { direction: 'inbound', text: 'Dobrý den, smlouvu vám pošlu v pondělí. Hezký víkend, Petra', age: 'today' },
    ],
    summary: { currentState: 'Čekáte na návrh smlouvy od Petry', risks: [], nextSteps: ['Petra pošle smlouvu v pondělí'], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Petra',
    channel: 'email',
    enrichment: {
      parties: ['Petra'],
      subject: 'Smlouva',
      messageType: 'update',
      coreIntent: 'Příslib zaslání smlouvy v pondělí',
      addresses: [],
      proposedTimes: [],
      urgency: { quote: 'smlouvu vám pošlu v pondělí', classification: 'SOFT REFERENCE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      no_action: true,
      has_revisit: true,  // should set revisit_at to Monday or Tuesday
    },
  },

  {
    id: 10,
    name: 'Urgency must not be clamped to 2 for genuinely urgent message',
    sourceCommit: 'ba7473c',
    latestInbound: 'URGENTNÍ: Kupec chce podepsat dnes do 16:00, jinak odstupuje. Byt na Korunní 55, cena 8.5M. Potřebuji vaše potvrzení IHNED.',
    recentMessages: [
      { direction: 'inbound', text: 'URGENTNÍ: Kupec chce podepsat dnes do 16:00, jinak odstupuje. Byt na Korunní 55, cena 8.5M. Potřebuji vaše potvrzení IHNED.', age: 'today' },
    ],
    summary: { currentState: 'Urgentní podpis', risks: ['Kupec může odstoupit'], nextSteps: [], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Broker',
    channel: 'email',
    enrichment: {
      parties: ['Broker'],
      subject: 'Urgentní podpis',
      coreIntent: 'Požadavek na okamžité potvrzení podpisu',
      addresses: ['Korunní 55'],
      proposedTimes: [],
      urgency: { quote: 'dnes do 16:00, jinak odstupuje', classification: 'HARD DEADLINE' },
      keyNumbers: { price: '8 500 000 Kč' },
    },
    journalText: '',
    assert: {
      needs_action: true,
      urgency_category: 'CRITICAL',
      type: 'REPLY',  // needs to confirm, not schedule
    },
  },

  {
    id: 11,
    name: 'WhatsApp short message — valid SCHEDULE, not over-questioned',
    sourceCommit: '862e80a',
    latestInbound: 'Čau, zítra v 10 u toho bytu na Letný?',
    recentMessages: [
      { direction: 'inbound', text: 'Čau, zítra v 10 u toho bytu na Letný?', age: 'today' },
    ],
    summary: { currentState: 'Jednání o bytu na Letné', risks: [], nextSteps: [], keyPoints: [], confidence: 0.7, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Jakub',
    channel: 'whatsapp',
    enrichment: {
      parties: ['Jakub'],
      subject: 'Prohlídka bytu na Letné',
      messageType: 'meeting_request',
      coreIntent: 'Návrh prohlídky zítra v 10:00',
      addresses: [],  // "na Letný" is a neighborhood, not a street address
      proposedTimes: [{ original: 'zítra v 10', interpreted: 'zítra 10:00', relativeRef: 'tomorrow', timeOfDay: '10:00', eventContext: 'viewing' }],
      meetingType: 'prohlídka bytu',
      urgency: { quote: 'zítra v 10', classification: 'HARD DEADLINE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      time_index: 0,
      venue_index: null,  // "Letná" is a neighborhood, not an address
      max_missing_info: 2,
    },
  },

  {
    id: 12,
    name: 'Newsletter/automated email must not produce action',
    sourceCommit: '7081204',
    latestInbound: 'Nové nemovitosti v Praze tento týden: 3+kk Vinohrady 6.2M, 2+1 Žižkov 4.1M, 4+kk Dejvice 12.5M. Odhlásit se z newsletteru.',
    recentMessages: [
      { direction: 'inbound', text: 'Nové nemovitosti v Praze tento týden: 3+kk Vinohrady 6.2M, 2+1 Žižkov 4.1M, 4+kk Dejvice 12.5M. Odhlásit se z newsletteru.', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Reality Portal',
    channel: 'email',
    enrichment: {
      parties: ['Reality Portal'],
      subject: 'Nové nemovitosti',
      messageType: 'newsletter',
      coreIntent: 'Týdenní přehled nových nemovitostí',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      no_action: true,
    },
  },

  {
    id: 13,
    name: 'REPLY vs TODO — question needs REPLY, not TODO',
    sourceCommit: '715dd01',
    latestInbound: 'Dobrý den, jaká je vaše představa o ceně za byt na Praze 5? Máme klienta se zájmem. Díky, Lenka',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, jaká je vaše představa o ceně za byt na Praze 5? Máme klienta se zájmem. Díky, Lenka', age: 'today' },
    ],
    summary: { currentState: 'Poptávka na byt na Praze 5', risks: [], nextSteps: [], keyPoints: [], confidence: 0.7, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Lenka',
    channel: 'email',
    enrichment: {
      parties: ['Lenka'],
      subject: 'Cenová představa',
      messageType: 'question',
      coreIntent: 'Dotaz na cenovou představu za byt na Praze 5',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'REPLY',  // this is a question requiring a reply, NOT a TODO
    },
  },

  {
    id: 14,
    name: 'Already-pending action should not be duplicated',
    sourceCommit: '7081204',
    latestInbound: 'Tak co, domluvíme tu prohlídku? Odpovězte prosím.',
    recentMessages: [
      { direction: 'inbound', text: 'Chtěl bych se podívat na ten byt. Můžeme domluvit prohlídku?', age: '2d ago' },
      { direction: 'inbound', text: 'Tak co, domluvíme tu prohlídku? Odpovězte prosím.', age: 'today' },
    ],
    summary: { currentState: 'CP čeká na domluvení prohlídky', risks: ['CP se opakovaně ptá'], nextSteps: ['Domluvit prohlídku'], keyPoints: [], confidence: 0.8, confidenceReason: '', dealType: 'sale' },
    pendingActions: [{ type: 'SCHEDULE', intent: 'Domluvit prohlídku bytu', urgency: 5 }],
    cpName: 'Ondřej',
    channel: 'email',
    enrichment: {
      parties: ['Ondřej'],
      subject: 'Prohlídka bytu',
      messageType: 'follow_up',
      coreIntent: 'Opakovaná žádost o domluvení prohlídky',
      addresses: [],
      proposedTimes: [],
      urgency: { quote: 'Odpovězte prosím', classification: 'SOFT REFERENCE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      // Existing SCHEDULE pending — should not create a new one.
      // Either no_action (existing covers it) or escalate existing urgency.
      no_action: true,
    },
  },

  {
    id: 15,
    name: 'Online meeting must not require address',
    sourceCommit: '0100e4f',
    latestInbound: 'Můžeme to probrat přes videohovor? Zítra odpoledne by mi vyhovovalo. Pošlu vám link na Teams.',
    recentMessages: [
      { direction: 'inbound', text: 'Můžeme to probrat přes videohovor? Zítra odpoledne by mi vyhovovalo. Pošlu vám link na Teams.', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'David',
    channel: 'email',
    enrichment: {
      parties: ['David'],
      subject: 'Videohovor',
      messageType: 'meeting_request',
      coreIntent: 'Návrh videohovoru zítra odpoledne',
      addresses: [],
      proposedTimes: [{ original: 'zítra odpoledne', interpreted: 'zítra odpoledne', relativeRef: 'tomorrow', timeOfDay: null, eventContext: 'online_meeting' }],
      meetingType: 'online meeting',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      venue_index: null,  // online meeting — no physical venue
      time_index: 0,
    },
  },
]

// ─── Runner ────────────────────────────────────────────────────────────────

interface CaseResult {
  id: number
  name: string
  pass: boolean
  failures: string[]
  raw?: Record<string, unknown>
}

async function runCase(tc: EvalCase): Promise<CaseResult> {
  const failures: string[] = []

  try {
    const result = await triageConversation(
      tc.latestInbound,
      tc.recentMessages,
      tc.summary,
      tc.pendingActions,
      tc.cpName,
      tc.channel,
      TEST_SETTINGS,
      tc.journalText,
      tc.enrichment,
    )

    // Check assertions
    const a = tc.assert

    if (a.no_action === true && result.needs_action) {
      failures.push(`Expected no action, got needs_action=true (type=${result.action?.type})`)
    }

    if (a.needs_action === true && !result.needs_action) {
      failures.push(`Expected needs_action=true, got false`)
    }

    if (a.has_revisit === true && !result.revisit_at) {
      failures.push(`Expected revisit_at to be set, got null`)
    }

    if (result.needs_action && result.action) {
      const action = result.action

      if (a.type && action.type !== a.type) {
        failures.push(`Expected type=${a.type}, got ${action.type}`)
      }

      if (a.urgency_category && action.urgency_category !== a.urgency_category) {
        failures.push(`Expected urgency_category=${a.urgency_category}, got ${action.urgency_category}`)
      }

      if (a.venue_index !== undefined && action.venue_index !== a.venue_index) {
        failures.push(`Expected venue_index=${a.venue_index}, got ${action.venue_index}`)
      }

      if (a.time_index !== undefined && action.time_index !== a.time_index) {
        failures.push(`Expected time_index=${a.time_index}, got ${action.time_index}`)
      }

      if (a.intent_contains && !action.intent_cs.toLowerCase().includes(a.intent_contains.toLowerCase())) {
        failures.push(`Expected intent_cs to contain "${a.intent_contains}", got "${action.intent_cs}"`)
      }

      if (a.intent_not_contains && action.intent_cs.toLowerCase().includes(a.intent_not_contains.toLowerCase())) {
        failures.push(`Expected intent_cs to NOT contain "${a.intent_not_contains}", got "${action.intent_cs}"`)
      }

      if (a.max_missing_info !== undefined && (action.missing_info?.length || 0) > a.max_missing_info) {
        failures.push(`Expected max ${a.max_missing_info} missing_info items, got ${action.missing_info?.length || 0}`)
      }
    }

    return {
      id: tc.id,
      name: tc.name,
      pass: failures.length === 0,
      failures,
      raw: result as unknown as Record<string, unknown>,
    }
  } catch (err) {
    return {
      id: tc.id,
      name: tc.name,
      pass: false,
      failures: [`THREW: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const caseFlag = args.indexOf('--case')
  const singleCase = caseFlag >= 0 ? parseInt(args[caseFlag + 1], 10) : null

  const cases = singleCase
    ? EVAL_CASES.filter(c => c.id === singleCase)
    : EVAL_CASES

  if (cases.length === 0) {
    console.error(`No test case with id=${singleCase}`)
    process.exit(1)
  }

  if (!jsonMode) {
    console.log(`\nRunning ${cases.length} triage eval cases...\n`)
  }

  const results: CaseResult[] = []

  // Run sequentially to avoid rate limits
  for (const tc of cases) {
    if (!jsonMode) process.stdout.write(`  #${tc.id} ${tc.name}... `)
    const result = await runCase(tc)
    results.push(result)
    if (!jsonMode) {
      if (result.pass) {
        console.log('PASS')
      } else {
        console.log('FAIL')
        for (const f of result.failures) console.log(`    - ${f}`)
      }
    }
  }

  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length

  if (jsonMode) {
    console.log(JSON.stringify({ passed, failed, total: results.length, results }, null, 2))
  } else {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Results: ${passed}/${results.length} passed, ${failed} failed`)
    console.log(`Pass rate: ${Math.round((passed / results.length) * 100)}%`)
    if (failed > 0) {
      console.log(`\nFailed cases:`)
      for (const r of results.filter(r => !r.pass)) {
        console.log(`  #${r.id}: ${r.name}`)
        for (const f of r.failures) console.log(`    - ${f}`)
      }
    }
    console.log()
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Eval harness error:', err)
  process.exit(1)
})
```

### 6b. Add npm script

Add to package.json scripts:

```json
"eval:triage": "tsx scripts/eval-triage.ts"
```

### 6c. How to use — the measurement protocol

This is the critical part. The eval harness is useless if you don't follow this protocol:

**Before ANY triage prompt change:**
```bash
npm run eval:triage > eval-before.json -- --json
```

**After the change:**
```bash
npm run eval:triage > eval-after.json -- --json
```

**Decision rule:**
- Pass rate went UP or stayed the same → keep the change
- Pass rate went DOWN → revert the change, no exceptions
- A previously-passing case now fails → revert, even if overall rate is the same (regression)

**When to add new cases:**
- Every time a user reports a bad triage decision, add it as case #N+1 with the correct expected result
- Every time you fix a triage bug, the bug's input becomes a new eval case
- Target: 30 cases within the first 2 weeks, 50 within a month

**When to update existing cases:**
- NEVER change expected results to make a failing case pass. That defeats the purpose.
- Only update if the business requirement genuinely changed (e.g., user says "actually, newsletters SHOULD get actions")

### 6d. Execution order within this refactor

Run the eval harness at THREE points:

1. **Before Step 1** (baseline measurement on the CURRENT triage prompt):
   ```bash
   npm run eval:triage
   ```
   Record the pass rate. This is your baseline. Even if it's 40%, that's fine — you now have a number.

2. **After Step 5** (after all code changes, before committing):
   ```bash
   npm run eval:triage
   ```
   Compare to baseline. The pass rate must be equal or higher. If it dropped, the refactor made things worse — investigate which cases regressed before committing.

3. **After any future prompt tweak** (ongoing):
   ```bash
   npm run eval:triage
   ```
   This is permanent. No prompt change ships without an eval run.

### 6e. What the 15 test cases cover

| # | Bug type | Source commit | Tests that... |
|---|----------|---------------|---------------|
| 1 | Address hallucination | 0100e4f | venue comes from enrichment list, not invented |
| 2 | Urgency miscalibration | 0100e4f | hard deadline → CRITICAL category |
| 3 | False positive (confirmation) | 7081204 | confirmation = no action needed |
| 4 | CP request buried | b01f1bc | docs + meeting → both surface |
| 5 | Signature ≠ venue | 0100e4f | signature address not used as venue |
| 6 | Interrogatory missing_info | 862e80a | max 2 missing_info items |
| 7 | SCHEDULE vs TODO confusion | b858a4f | confirmed viewing = SCHEDULE |
| 8 | Fact fabrication | 58abd9b | intent doesn't fabricate requests |
| 9 | Revisit vs action | 7081204 | "will send Monday" = revisit |
| 10 | Urgency over-clamping | ba7473c | genuinely urgent = CRITICAL |
| 11 | WhatsApp short msg | 862e80a | minimal msg still works, no over-questioning |
| 12 | Newsletter false positive | 7081204 | newsletter = no action |
| 13 | REPLY vs TODO | 715dd01 | question = REPLY, not TODO |
| 14 | Dedup against pending | 7081204 | existing pending blocks duplicate |
| 15 | Online meeting | 0100e4f | no address needed for video call |

Every past bug commit is a free regression test. The harness catches them before they recur.

---

## Summary of what changes

| Before | After |
|--------|-------|
| Triage extracts addresses free-text | Triage picks from enrichment list by index |
| Triage extracts proposed_time free-text | Triage picks from enrichment list by index |
| Triage estimates dollar_value from scratch | Code parses enrichment keyNumbers.price |
| Triage extracts meeting_type | Code reads enrichment meetingType |
| Triage extracts cp_phone | Removed (from CP record downstream) |
| Urgency: AI picks 1-10 number | AI picks 5 categories, code maps to number |
| verifyTriage: 3 AI questions | 1 AI question (action_justified) + code gates |
| TriageAction: 22 fields | TriageAction: 13 fields |
| Triage prompt: ~100 lines of rules | Triage prompt: ~55 lines of rules |
