# Planning Pipeline Decomposition — Implementation Plan

## Date: 2026-04-09

## Problem

`proposeAction()` in `src/lib/ai/gemini.ts` is a single ~500-line prompt asking Haiku to perform 15 simultaneous cognitive tasks. Every rule added to fix one failure class degrades another (zero-sum prompt interference). The enrichment pipeline (`enrichMessage()`) correctly extracts structured data (addresses, times, urgency signals), but `proposeAction` ignores it and re-derives everything from raw conversation text.

## What replaces it

Three AI prompts in sequence, plus three deterministic code functions. The old `proposeAction` is deleted entirely.

### The 3 AI prompts (in order)

**Prompt 1: `extractCPRequest()` — already exists, unchanged**
- Location: `src/lib/ai/gemini.ts` line 199
- Stage: `enrichment` (Gemini Flash, no thinking, temperature 0)
- Input: latest inbound message text, CP name
- Output: plain text string — what the CP is asking, quoting their words
- This locks in the CP's actual request before any planning happens

**Prompt 2: `decideActionType()` — new, replaces the classification part of proposeAction**
- Location: `src/lib/ai/gemini.ts` (new function)
- Stage: `planning_type` (Haiku, thinking budget 512, fallback Gemini Flash)
- Input: cpRequest string, enrichedText string, conversationSummary JSON, cpName, settings
- Output: `ActionTypeDecision[]` — array of `{ actionType: 'REPLY'|'SCHEDULE'|'TODO', rationale_cs: string }`
- NO raw messages. NO urgency rules. NO address rules. NO dollar values. NO intent text. Just: what does the user need to do?
- Key rules kept: SCHEDULE absorbs REPLY, confirmation = SCHEDULE not TODO, SCHEDULE when meeting times exist
- ~60 line prompt

**Prompt 3: `generateIntent()` — new, replaces the content generation part of proposeAction**
- Location: `src/lib/ai/gemini.ts` (new function)
- Stage: `planning_intent` (Haiku, thinking budget 1024, fallback Gemini Flash)
- Input: locked actionType + rationale_cs from Prompt 2, cpRequest, enrichedText, conversationSummary, cpName, settings, channel, journalText
- Output: `ActionIntentResult` — `{ intent_cs, missingInfo, dollarValue, dealType, meetingType, weight, immovable, cpPhone }`
- Knows the action type is already decided — does not second-guess it
- NO urgency (computed in code). NO address selection (computed in code). NO suggestedTime (extracted in code).
- Key rules kept: proactive intent voice ("vy" not "uživatel"), TODO as numbered checklist, specific concrete descriptions, missingInfo as full questions
- ~80 line prompt

### The 3 deterministic code functions (no AI)

**Function 1: `computeUrgencyFromEnrichment(enriched, today)` — new**
- Location: `src/services/planning.ts` (new function, ~40 lines)
- Input: `EnrichedMessageData | null`, today's Date
- Output: `{ deadlineUrgency: number, meetingPrepUrgency: number }`
- Logic for `deadlineUrgency` (from `enriched.urgency`):
  - `HARD DEADLINE` + quote contains "dnes"/"today"/"do [time]" → 10
  - `HARD DEADLINE` + quote contains "zítra"/"tomorrow" → 9
  - `HARD DEADLINE` + quote contains specific weekday name → 8
  - `HARD DEADLINE` + quote contains "tento týden" → 7
  - `HARD DEADLINE` + quote contains consequence word ("jinak"/"propadá") → 7
  - `HARD DEADLINE` + no recognizable pattern → 7 (assume this week)
  - `SOFT REFERENCE` + quote contains "žádný spěch"/"no rush" → 1
  - `SOFT REFERENCE` otherwise → 5
  - No urgency signal at all → 2
- Logic for `meetingPrepUrgency` (from `enriched.proposedTimes[0].isoDate`):
  - Parse ISO date, compute days until meeting
  - 0 days → 10, 1 day → 9, 2-3 days → 8, 4-5 days → 7, else → 5
  - No proposed times or no parseable isoDate → 2
- Per-action urgency assignment in orchestrator:
  - SCHEDULE: `Math.max(deadlineUrgency, meetingPrepUrgency)`
  - TODO with sibling SCHEDULE: `Math.max(meetingPrepUrgency, deadlineUrgency - 1)`
  - REPLY: `deadlineUrgency`
  - TODO standalone: `deadlineUrgency`

**Function 2: `selectMeetingLocation(enriched)` — new**
- Location: `src/services/planning.ts` (new function, ~20 lines)
- Input: `EnrichedMessageData | null`
- Output: `{ location: string | null, confidence: 'high' | 'low' | null }`
- Logic:
  - If enrichment's meetingType contains phone/call keywords → `{ null, null }` (no location needed)
  - If enrichment's meetingType contains online/video keywords → `{ null, null }`
  - If no addresses in enrichment → `{ null, null }`
  - If 1 address → `{ addresses[0], 'high' }`
  - If multiple addresses → `{ addresses[0], 'low' }` (first = likely from body, not signature)
- No AI. No hallucination. Geocoding still runs after this via existing `validateMeetingLocation()`.

**Function 3: `extractSuggestedTime(enriched)` — new**
- Location: `src/services/planning.ts` (new function, ~10 lines)
- Input: `EnrichedMessageData | null`
- Output: `string | null` (ISO 8601 datetime)
- Logic: return `enriched.proposedTimes[0].isoDate` if present, else null
- Requires enrichment prompt change (see below)

### Enrichment prompt change

`enrichMessage()` in `src/lib/ai/gemini.ts` gets one small addition:

- `EnrichedMessageData.proposedTimes` type changes from `{ original, interpreted }[]` to `{ original, interpreted, isoDate? }[]`
- The enrichment prompt's JSON schema adds `"isoDate": "ISO 8601 datetime string or null"` to the proposedTimes output
- The enrichment prompt already has `TODAY'S DATE` context so it can compute ISO dates from relative expressions
- This enables both `computeUrgencyFromEnrichment` (date math) and `extractSuggestedTime` (direct read)

### Orchestration: rewritten `generateActionProposal()` in `planning.ts`

The existing function is rewritten to call the new pipeline. The flow:

```
1. [existing] Get conversation, CP, channel, settings, timeline, recent messages (unchanged)
2. [existing] buildMilaContext → get enriched data, journal, timeline
3. [existing] extractCPRequest → cpRequest string
4. [NEW]      decideActionType(cpRequest, enrichedText, summary, cpName, settings) → ActionTypeDecision[]
5. [NEW]      Filter: if SCHEDULE exists, remove any REPLY (safety net for SCHEDULE-absorbs-REPLY)
6. [NEW]      computeUrgencyFromEnrichment(enriched, today) → { deadlineUrgency, meetingPrepUrgency }
7. [NEW]      For each action type decision:
               a. Compute urgency based on action type (see rules above)
               b. If SCHEDULE: selectMeetingLocation(enriched) → location
               c. If SCHEDULE: extractSuggestedTime(enriched) → suggestedTime
               d. generateIntent(decision, cpRequest, enrichedText, summary, cpName, settings, channel, journalText) → intent details
               e. Assemble ProposedAction from all pieces
8. [existing] Dedup with existing pending actions (unchanged)
9. [existing] Geocode location via validateMeetingLocation (unchanged)
10. [existing] Calculate priority score (unchanged)
11. [existing] Create action in DB (unchanged)
```

### What gets deleted

| Function | Location | Why |
|----------|----------|-----|
| `proposeAction()` | `src/lib/ai/gemini.ts` (lines 321-534) | Replaced by `decideActionType` + `generateIntent` |
| `reviewUrgency()` | `src/lib/ai/gemini.ts` (lines 542-605) | Already disabled. Urgency now computed in code. |
| `applyEnrichmentOverrides()` | `src/services/planning.ts` (lines 57-93) | No overrides needed when enrichment IS the source |
| `applyActionTypeCorrections()` | `src/services/planning.ts` (lines 100-135) | No corrections needed when action type prompt is narrow |

### `ai-models.ts` changes

Remove stages: `planning`, `urgency_review`

Add stages:
```typescript
planning_type: {
  primary: 'claude-haiku-4-5-20251001',
  fallback1: 'gemini-2.5-flash',
  fallback2: null,
  thinkingBudget: 512,
}

planning_intent: {
  primary: 'claude-haiku-4-5-20251001',
  fallback1: 'gemini-2.5-flash',
  fallback2: null,
  thinkingBudget: 1024,
}
```

### Test file changes

Two test files mock `proposeAction` from `@/lib/ai/gemini`. Both need updating:

**`src/services/integration.test.ts`:**
- Mock factory: replace `proposeAction: vi.fn()` with `decideActionType: vi.fn(), generateIntent: vi.fn(), extractCPRequest: vi.fn()`
- Import: replace `proposeAction` with `decideActionType, generateIntent, extractCPRequest`
- beforeEach mocks: `decideActionType` returns `[{ actionType: 'REPLY', rationale_cs: '...' }]`, `generateIntent` returns `{ intent_cs, missingInfo, dollarValue, dealType, meetingType, weight, immovable, cpPhone }`, `extractCPRequest` returns `''`
- Assertion `expect(proposeAction).not.toHaveBeenCalled()` becomes `expect(decideActionType).not.toHaveBeenCalled()`

**`src/services/agent-pipeline.test.ts`:**
- Same pattern as integration.test.ts

### Types

`ProposedAction` type stays in `gemini.ts` — it's the assembled type that `generateActionProposal()` builds from all the pieces. No change to its shape.

New types in `gemini.ts`:
```typescript
export type ActionTypeDecision = {
  actionType: ActionType
  rationale_cs: string
}

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
```

## Implementation instruction for new chat

Write complete files using the Write tool. Do NOT use Edit for piecemeal changes on large files. Write the entire new `gemini.ts` and `planning.ts` in one shot each. Then update `ai-models.ts`, the two test files, and CLAUDE.md. Run `npm test && npm run build` after each file to catch errors early.

## Problems solved and predictions

| Problem | Current state | After | Confidence |
|---------|--------------|-------|------------|
| **Intent misidentification** (CP asks for documents, Mila responds about financing) | Happens regularly. extractCPRequest works but mega-prompt overrides it. | decideActionType receives CP request as primary input, no raw messages, nothing to drift toward. **~85% reduction.** | High |
| **Address confusion** (signature address used as venue, hallucinated addresses) | applyEnrichmentOverrides catches some via substring match. Many slip through. | No AI chooses the address. Code reads enrichment's `addresses[]`. Hallucination eliminated. **~90% reduction.** | High |
| **Urgency miscalibration** ("do 17:00" = urgency 10, Mila says 9) | AI assigns urgency inside mega-prompt, competes with 14 other tasks. | Date math in code. "HARD DEADLINE" + "do 17:00" + today → 10. No AI judgment. **~80% reduction** for explicit deadlines. | High for explicit, medium for soft |
| **Action type confusion** (TODO "confirm deal" instead of SCHEDULE) | Mega-prompt has 200 words of rules competing with 14 other tasks. | 60-line prompt with one job. **~75% reduction.** | Medium-high |
| **Prompt rule interference** (fixing one thing breaks another) | Zero-sum. 500-line prompt. Every rule competes. | Eliminated by decomposition. **100% elimination.** | Very high |
| **Enrichment-to-proposal disconnect** (correct data extracted, then ignored) | Enriched data injected as text. AI re-derives from raw conversation. | Enrichment is the structured input that code consumes directly. **~95% reduction.** | Very high |

## What won't improve

- enrichMessage itself getting extraction wrong (~5-10% of messages)
- Genuinely ambiguous Czech ("potvrďte" meaning 3 things) — ~10-15% of cases
- Outbound-only conversations (no inbound = extractCPRequest returns empty)

## Net estimate

Current: ~60-65% proposal accuracy. After: ~85-90%.

## Cost impact

Total AI calls per conversation: 3 (was 2). Net cost roughly neutral — one mega-prompt with 2048 thinking ≈ two narrow prompts with 512+1024 thinking. Input tokens drop because each narrow prompt gets less context.

## Design rule

**Never re-derive in AI what enrichment already extracted.** Enrichment is the structured input. Planning consumes it. If enrichment is wrong, fix enrichment — don't add a second AI call to override it.
