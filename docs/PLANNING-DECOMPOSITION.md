# Planning Pipeline Decomposition — Implementation Plan

## Date: 2026-04-09

## Problem

`proposeAction()` is a single ~500-line prompt asking Haiku to perform 15 simultaneous cognitive tasks. Every rule added to fix one failure class degrades another (zero-sum prompt interference). The enrichment pipeline correctly extracts structured data (addresses, times, urgency signals), but proposeAction ignores it and re-derives everything from raw conversation text.

## What changes

### 1. Split `proposeAction()` in `gemini.ts` into two new functions

- `decideActionType()` — ~60 line prompt, Haiku thinking 512, returns `actionType[]` + `rationale_cs`
- `generateIntent()` — ~80 line prompt, Haiku thinking 1024, returns `intent_cs`, `missingInfo`, `dollarValue`, `dealType`

### 2. New function `computeUrgencyFromEnrichment()` in `planning.ts`

Pure date math, ~40 lines, no AI. Reads enrichment's `urgency.classification` + `proposedTimes`, computes urgency number.

### 3. New function `selectMeetingLocation()` in `planning.ts`

Pure code, ~20 lines. Reads enrichment's `addresses[]`, picks venue.

### 4. New function `extractSuggestedTime()` in `planning.ts`

Pure code, ~15 lines. Reads enrichment's `proposedTimes[]`, converts to ISO 8601.

### 5. Rewrite `generateActionProposal()` in `planning.ts`

New pipeline: extractCPRequest → decideActionType → computeUrgency/selectLocation/extractTime (code) → generateIntent

### 6. Delete dead code

- `applyEnrichmentOverrides()`
- `applyActionTypeCorrections()`
- `reviewUrgency()`

### 7. Update `ai-models.ts`

Replace single `planning` stage with `planning_type` (512 thinking) and `planning_intent` (1024 thinking).

### 8. Update CLAUDE.md

Document the decomposed pipeline (~30 lines in AI Model Configuration section).

### 9. Update existing tests

Match new function signatures.

### 10. Verify

Run `npm test && npm run build`, commit, push.

## Problems solved and predictions

| Problem | Current state | After | Confidence |
|---------|--------------|-------|------------|
| **Intent misidentification** (CP asks for documents, Mila responds about financing) | Happens regularly. extractCPRequest works but mega-prompt overrides it. | decideActionType receives CP request as primary input, no raw messages, nothing to drift toward. **~85% reduction in misidentification.** | High — the pre-extraction already works, we just stop ignoring it. |
| **Address confusion** (signature address used as venue, hallucinated addresses) | applyEnrichmentOverrides catches some cases via substring match. Many slip through. | No AI chooses the address. Code reads enrichment's `addresses[]`. Hallucination eliminated. Signature-vs-venue confusion reduced to whatever enrichMessage gets wrong. **~90% reduction.** | High — removing the AI from address selection removes the failure mode entirely. |
| **Urgency miscalibration** ("do 17:00" = urgency 10, Mila says 9) | AI assigns urgency inside mega-prompt, competes with 14 other tasks. Urgency review was built then disabled. | Date math in code. "HARD DEADLINE" + "do 17:00" + today → 10. No AI judgment. **~80% reduction** in miscalibration for explicit deadlines. Ambiguous cases ("brzy") stay AI-dependent via the action type prompt. | High for explicit deadlines. Medium for soft references (still heuristic). |
| **Action type confusion** (TODO "confirm deal" instead of SCHEDULE) | Mega-prompt has 200 words of rules. applyActionTypeCorrections regex catches some. | 60-line prompt with one job. Enrichment's `proposedTimes` + `meetingType` feed the decision. If enrichment found a meeting time, the prompt knows. **~75% reduction.** | Medium-high — narrow prompt helps a lot, but genuinely ambiguous cases remain. |
| **Prompt rule interference** (fixing one thing breaks another) | Zero-sum. 500-line prompt. Every rule competes. | Eliminated by decomposition. Each prompt has one job. Adding a rule to action-type prompt cannot affect intent generation. **100% elimination** of cross-task interference. | Very high — this is architectural, not probabilistic. |
| **Enrichment-to-proposal disconnect** (correct data extracted, then ignored) | Enriched data injected as supplementary text. AI re-derives from raw conversation. | Enrichment is the structured input that code consumes directly. AI never re-derives addresses, times, or urgency. **~95% reduction.** | Very high — the disconnect is eliminated by design. |

## What won't improve

- enrichMessage itself getting extraction wrong (~5-10% of messages) — untouched, different prompt
- Genuinely ambiguous Czech ("potvrdte" meaning 3 things) — still requires context, ~10-15% of cases
- Outbound-only conversations (no inbound = extractCPRequest returns empty) — rare, unchanged

## Net estimate

Current overall proposal accuracy: ~60-65%.
After: **~85-90%** on the same case mix. The remaining 10-15% are genuine ambiguity + enrichment extraction errors.

## Cost impact

| Prompt | Thinking budget | Notes |
|--------|-----------------|-------|
| decideActionType | 512 | One classification decision. Short input. |
| generateIntent | 1024 | Synthesizes specifics from context. Still narrow. |
| extractCPRequest (existing) | 0 (no thinking) | Already works without thinking. Unchanged. |
| enrichMessage (existing) | 0 (no thinking) | Already works. Temperature 0. Unchanged. |

Total AI calls per conversation per pipeline run: 3 (was 2). Net cost roughly neutral — one mega-prompt with 2048 thinking ≈ two narrow prompts with 512+1024 thinking. Input tokens drop because each narrow prompt gets less context.

## Design rule

**Never re-derive in AI what enrichment already extracted.** Enrichment is the structured input. Planning consumes it. If enrichment is wrong, fix enrichment — don't add a second AI call to override it.
