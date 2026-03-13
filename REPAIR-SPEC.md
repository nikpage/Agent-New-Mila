# REPAIR-SPEC — Restoring Mila's Core Judgment

**Date:** 2026-03-13
**Status:** Awaiting Nik's review
**Purpose:** Fix three things that prevent Mila from doing her job. No formula changes. No refactoring. No "improvements."

---

## Context

An email arrives:
- 45M CZK deal, notary signing tomorrow 9 AM
- User must confirm by 5 PM today or deal falls through
- User needs to bring 3 documents

Mila should: create a REPLY (confirm by 5pm), a SCHEDULE (block notary 9am), and a TODO (gather documents). Then instantly notify the user.

Mila currently: picks ONE action (usually SCHEDULE because "notary appointment" triggers scheduling keywords), never sends an instant notification, and the user finds out in the next morning brief — after the deadline.

---

## REPAIR 1 — Restore multi-action per conversation

### What was destroyed
The AI prompt originally said: "If the conversation needs multiple actions (e.g. reply + schedule), return an array."
It was changed to: "pick ONE per conversation."
`generateActionProposal()` was changed from returning an array to returning a single action.
`hasPendingAction()` was added to block creating additional actions for the same conversation.

### What to fix

**File: `src/lib/ai/gemini.ts` — `proposeAction()`**

1. Change the prompt instruction from "pick ONE per conversation" back to allowing multiple actions:
   - Remove: `CRITICAL - ACTION TYPE RULES (pick ONE per conversation):`
   - Replace with: `ACTION TYPE RULES — return one OR multiple actions:`
   - Remove rule 8: "If the conversation needs both a reply AND scheduling, use SCHEDULE"
   - Add: "If the conversation requires multiple actions (e.g. confirm a deal AND block a calendar slot AND gather documents), return an array of objects. Each action is independent."
   - Keep all other rules (REPLY/SCHEDULE/TODO definitions, voice rules, formatting rules)

2. Change the JSON instruction from single object to array-capable:
   - "Respond with ONLY valid JSON — an array of one or more action objects:"
   - Each object keeps the same schema (actionType, rationale_cs, intent_cs, missingInfo, urgency, dollarValue, weight, dealType, suggestedLocation, suggestedTime)
   - urgency, dollarValue, weight, dealType are per-action — different actions from the same email can have different urgency

3. Update the response parser to handle both array and single object (backward safe):
   ```
   const parsed = JSON.parse(jsonMatch[0])
   return Array.isArray(parsed) ? parsed : [parsed]
   ```
   Return type changes to `ProposedAction[]`

**File: `src/services/planning.ts` — `generateActionProposal()`**

4. Remove the `hasPendingAction()` check on line 86. This check prevents Mila from ever creating a second action for a conversation. It was not in the original design.

5. Change return type from `ActionProposal | null` to `ActionProposal[]`

6. Loop over the array from `proposeAction()` and create one DB action per proposal. Each gets its own priority score calculated independently.

7. SCHEDULE-specific payload logic (lines 156-189) applies only to items where `actionType === 'SCHEDULE'`

**File: `src/services/planning.ts` — `generateActionsForConversations()`**

8. Update to collect arrays instead of single actions. Flatten results into the final array.

### What NOT to touch
- `calculatePriorityScore` — unchanged
- `createAction` — unchanged (called once per action, just called multiple times now)
- Morning brief rendering — unchanged (already handles multiple actions)
- Lead tracking — unchanged
- Tests that pin scoring values — unchanged

---

## REPAIR 2 — Fix classification bias

### What's wrong
The prompt rules (gemini.ts lines 241-248) aggressively force SCHEDULE whenever any time/meeting word appears. Rule 1 lists: "meeting, schůzka, prohlídka, viewing, visit, setkání, oběd, lunch, návštěva, proposed time, confirmation of time..." Rule 8: "If the conversation needs both a reply AND scheduling, use SCHEDULE."

This means "notary appointment tomorrow at 9 AM" forces SCHEDULE even though the primary urgency is "confirm by 5pm" (REPLY) and "bring documents" (TODO).

### What to fix

**File: `src/lib/ai/gemini.ts` — `proposeAction()` prompt**

1. Since multi-action is restored (Repair 1), remove rule 8 entirely ("If the conversation needs both a reply AND scheduling, use SCHEDULE"). The AI can now return both.

2. Simplify the action type definitions:
   - REPLY — the user needs to send a message (confirm, answer, respond)
   - SCHEDULE — the user needs to be somewhere at a specific time (block calendar, create event)
   - TODO — the user needs to do something themselves that isn't a message or a meeting (gather documents, call someone, prepare something)

3. Remove the keyword list from SCHEDULE (line 241). The AI doesn't need a word list — it needs to understand the situation. "Notary appointment tomorrow 9 AM" is a SCHEDULE because the user needs to be at a place at a time, not because "appointment" is in a keyword list.

4. Add guidance: "One email may require multiple actions. A deal confirmation email might need a REPLY (confirm the deal), a SCHEDULE (block the appointment), and a TODO (gather documents). Return all of them."

---

## REPAIR 3 — Verify instant notification actually fires

### What might be wrong
The code uses `urgency >= 9`. The QStash schedule function exists (`createInstantNotifySchedule`). But:

1. **Was `createInstantNotifySchedule()` ever called?** It creates the QStash polling schedule. If nobody called it during setup, the `/api/cron/instant-notify` endpoint is never hit. The function exists but may never have been wired into user onboarding or system setup.

2. **Does the `urgency` column actually get written?** Check that `createAction()` in planning.ts passes `urgency` to the DB insert. → Yes, line 215: `urgency: proposal.urgency`. This is fine.

3. **Does the AI actually assign urgency 9-10?** The calibration in the prompt says "9 = tomorrow AT LATEST; 10 = less than 1 hour". An email saying "confirm by 5pm TODAY" should get 10. But the AI may be conservative. We can't control this directly — but we can improve the prompt.

### What to fix

**Verification step (before any code changes):**
- Check QStash dashboard or run `createInstantNotifySchedule()` manually to verify the polling schedule exists and is active
- Check Vercel logs for any `/api/cron/instant-notify` hits in the last 30 days
- If the schedule doesn't exist, that's why instant notify never fires — it was never set up

**File: `src/lib/ai/gemini.ts` — `proposeAction()` prompt**

1. Replace the urgency calibration with discrete values, no ranges:
   ```
   "urgency": 1-10 where:
     10 = deadline within hours (e.g. "confirm by 5pm today")
     9 = deadline tomorrow
     7 = deadline this week, significant value at risk
     5 = should respond within days, no hard deadline
     3 = routine, can wait
     1 = informational only
   ```
   No overlapping ranges. Each number means one thing.

**File: `src/services/planning.ts`**

2. After creating actions, log any with urgency >= 9:
   `console.log([Planning] URGENT action created: urgency=${urgency}, type=${actionType}, cp=${cpName})`
   This gives visibility into whether the AI is assigning high urgency.

---

## CLEANUP — Remove pain_factor references

`pain_factor` appears in:
- `src/lib/supabase/types.ts` lines 302, 326, 350 (DB type definitions)
- `src/__tests__/helpers/test-db.ts` line 155
- `docs/SCHEMA.md` line 40
- `CLAUDE.md` line 406

The DB column can stay (dropping columns is a migration risk for zero benefit). But all code references should treat it as dead — never read, never write, never test. Remove from test helpers. Remove from docs.

---

## Files touched (summary)

| File | Repair |
|------|--------|
| `src/lib/ai/gemini.ts` | 1 (multi-action prompt), 2 (classification), 3 (urgency scale) |
| `src/services/planning.ts` | 1 (multi-action return, remove hasPendingAction), 3 (urgent logging) |
| `src/__tests__/helpers/test-db.ts` | Cleanup (remove pain_factor) |
| `docs/SCHEMA.md` | Cleanup (note pain_factor as dead) |
| `CLAUDE.md` | Update after all repairs (multi-action, urgency scale, formula) |
| `SPEC.md` | Update after all repairs |

---

## What is NOT touched

- Morning brief rendering
- Instant notify email sending
- QStash client
- Threading
- Ingestion
- Lead tracking
- Embedding
- Mila voice
- Scheduling/optimizer
- Action card template
- Any API routes
- Any React components

---

## Implementation order

1. Repair 1 + 2 together (they're intertwined — multi-action enables correct classification)
2. Repair 3 (verify instant notify is actually running)
3. Cleanup
5. Update docs (CLAUDE.md, SPEC.md)
6. Run `npm test && npm run build`

---

## Test rules

- Do NOT modify expected values in pinning tests without Nik's approval
- New tests needed:
  - Multi-action: one conversation produces REPLY + SCHEDULE + TODO
  - Classification: "confirm by 5pm" → REPLY, "notary 9am" → SCHEDULE, "bring documents" → TODO
  - Urgency: "confirm by 5pm today" → urgency 10
