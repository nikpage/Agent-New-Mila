# BUGFIX-SPEC — Three Scheduling/Notification Bugs + Scoring Fix

**Date:** 2026-03-12
**Status:** Ready for implementation
**Author:** Analysis by Claude (analyst), approved by Nik

---

## BUG 1 — Instant notification never fires

### Problem
Instant notifications use `priority_score > 79` to trigger. But a brand-new action (daysIgnored=0) with normal weight maxes out around score 55 even for a 45M deal at urgency 10. The threshold is unreachable on day 0. By the time daysIgnored² pushes the score past 79, the deadline has already passed.

### Root cause
Priority score formula is designed for ORDERING actions in the brief, not for ALERTING. Urgency already measures "does this need immediate attention."

### Fix
Use urgency alone for instant notification eligibility.

**File: `src/lib/db/actions.ts`**
- `getHighPriorityUnnotifiedActions()`: change `.gt('priority_score', threshold)` to `.gte('urgency', threshold)`
- Parameter name: `threshold` → `urgencyThreshold`, default value: `9`

**File: `src/services/morning-brief.ts`**
- Rename `DEFAULT_INSTANT_THRESHOLD` (currently 79) → `DEFAULT_INSTANT_URGENCY_THRESHOLD` = `9`
- `sendInstantNotifications()` parameter: rename `threshold` → `urgencyThreshold`
- Update the call site and JSDoc

**No other files affected.** The downstream email template, `markActionsInstantNotified`, and `queued_for_brief = true` behavior all stay the same.

### Test rules
- The pinning test MUST `import` the actual constant from the source module and assert against a hardcoded value. Example: `import { DEFAULT_INSTANT_URGENCY_THRESHOLD } from './morning-brief'` then `expect(DEFAULT_INSTANT_URGENCY_THRESHOLD).toBe(9)`. NEVER test a local variable against itself — that pins nothing.
- Add a test: urgency=9 action IS picked up; urgency=8 action is NOT

---

## BUG 2 — Hold event time doesn't match action card text

### Problem
A CP-stated meeting time (e.g. "9am tomorrow") can end up with the hold event at a different time than what the action card shows the user. The user approves "9am" but the calendar has "10am." This is a trust-breaking bug.

### Root cause
1. If `suggestedTime` from the AI fails to parse as a valid Date, `preferredDate` silently becomes `undefined` and `proposeMeeting()` falls to its fallback path — `findBestSlots()` — which picks the first free slot (e.g. 10am because the existing 9am event blocks it).
2. No verification that the hold event time matches what's presented in `intent_cs`.
3. CP-stated times are UNMOVABLE constraints. The scheduler must never silently pick a different slot. It must book at the stated time and flag the conflict for the user to resolve.

### Fix

**File: `src/services/planning.ts`**

1. **Verify hold matches preferredDate:** After `proposeMeeting()` returns, if `preferredDate` was set, assert that `holdEvent.start_time` matches `preferredDate`. If they differ, log an error — this is a code bug, not a normal condition.

2. **Verify intent matches hold:** After `generateSchedulingIntent()` returns, check that the hold event's formatted time (`slotText`) appears in the returned `intent_cs`. If the AI dropped or changed the time, force-include the correct time. This is a safety net.

3. **Never silently fall through:** If `preferredDate` is set but `proposeMeeting()` returns a hold at a DIFFERENT time, reject it. The hold MUST be at the CP-stated time. Conflicts are reported to the user, not resolved by moving the meeting.

**File: `src/services/scheduling.ts` — `proposeMeeting()`**

4. The function already correctly books the hold at `preferredDate` even on conflict (lines 547-548). Verify this path is never bypassed. The conflict path must ALWAYS create the hold at the stated time and return conflict info.

### Rules (from spec, restated for clarity)
- CP-stated time = hard constraint. Book the hold there. Period.
- If there's a w=100 event at the same time AND urgency 9-10: Mila flags it as needing immediate human attention and may suggest solutions. Mila does NOT decide — the user decides.
- The action card text and the actual hold event MUST show the same time. If they ever diverge, that's a bug.

### Test impact
- Add test: CP says "9am", existing event at 9am → hold is at 9am, conflict info returned, intent_cs contains "9:00"
- Add test: hold time ≠ action card time → error is raised

---

## BUG 3 — Double-booked meetings / scheduling race condition

### Problem
Meetings are double-booked because `generateActionProposal()` in planning.ts calls `proposeMeeting()` during the planning step. Planning runs up to 5 conversations in parallel — each SCHEDULE action independently finds free slots and creates holds. Two parallel tasks see the same slot as free before either creates a hold. Result: two holds at 11:15, 5-minute gap, buffer violated.

Meanwhile, `optimizeScheduleActions()` — the batch optimizer designed to handle all scheduling in one pass — exists, is tested, but is never called. Even after wiring it into `sendMorningBrief`, it can't fix holds already created during planning (it skips actions that have `hold_event_id`).

### Root cause
Planning should NOT create holds. Scheduling is a group-level batch operation that happens once, at brief time, via the optimizer. The `proposeMeeting()` call inside `generateActionProposal()` should never have been there.

### Fix

**File: `src/services/planning.ts` — `generateActionProposal()`**

1. **Remove the `proposeMeeting()` call** and all scheduling logic from `generateActionProposal()` (the entire `if (proposal.actionType === 'SCHEDULE')` block that calls `proposeMeeting`). Planning creates SCHEDULE actions with NO hold. Store the AI's scheduling context in the action payload instead:
   - `suggestedTime` (raw string from AI — the CP-stated time)
   - `suggestedLocation` (from AI or CP record)
   - `cp_availability` (from AI — e.g. "Tuesday afternoon", "tomorrow 9am")
   - `duration` (from settings or AI)
   - Do NOT call `proposeMeeting`, `blockSlotForProposal`, or `generateSchedulingIntent` here.
   - The `intent_cs` stays as the AI's raw intent — no scheduling details baked in yet.

**File: `src/services/morning-brief.ts` — `sendMorningBrief()`**

2. **Call `optimizeScheduleActions(userId)`** BEFORE building the `briefActions` array. This is where ALL slot selection happens — one pass, priority-ordered, buffer-aware, no race condition.

3. After the optimizer runs, it must **update each SCHEDULE action's payload** with the hold info (`hold_event_id`, `start`, `end`, `location`, `conflicts`) and **rewrite `intent_cs`** via `generateSchedulingIntent()` with the actual slot text. This way the action card always matches the hold.

**File: `src/services/scheduling.ts` — `optimizeScheduleActions()`**

4. The optimizer now handles ALL SCHEDULE actions (no `hold_event_id` filter needed — none will have holds).

5. **Read `cp_availability` and `suggestedTime` from action payload** to respect CP-stated times as hard constraints. If CP said "9am", book at 9am and report the conflict — don't pick a different slot.

6. **Buffer enforcement** stays as implemented: `bookedRanges` with `meeting_buffer_minutes` on both sides.

7. After creating each hold, **update the action record** in the DB with the hold info and rewritten `intent_cs`.

### Design principle
- **Planning** decides WHAT: "this conversation needs a meeting"
- **Optimizer** decides WHEN: assigns slots in one batch pass at brief time
- The action card text is written by the optimizer, not planning — so it always matches the actual hold

### Test impact
- Remove/update tests that expect `proposeMeeting` to be called from `generateActionProposal`
- Add test: SCHEDULE action created by planning has NO `hold_event_id`
- Add test: optimizer assigns slots to all SCHEDULE actions, no double-booking
- Add test: two meetings in same batch respect `meeting_buffer_minutes` gap
- Add test: CP-stated time is respected — optimizer books at that time even on conflict
- Existing 7 optimizer tests in `scheduling.test.ts` should still pass (may need adjustment for payload reading)

---

## SCORING — Fix `actions.test.ts` (prerequisite for formula change)

### Problem
The pinning tests in `actions.test.ts` use a helper function `expectedLogNorm()` that copies the production formula. Tests pass no matter what the formula does. They pin the algorithm, not the output. This is not a pinning test — it's tautological.

### Fix

1. **Delete** the `expectedLogNorm()` helper function entirely
2. **Replace** every `expect(score).toBe(expected)` that computed `expected` via the helper with a hardcoded integer value
3. Calculate the correct hardcoded values from the CURRENT formula (before any formula changes), so that the pins capture the current behavior

Example — change this:
```typescript
const norm = expectedLogNorm(1_000_000)
const expected = Math.round(norm + 5 + Math.pow(2, 2) + 0)
expect(score).toBe(expected)
```

To this:
```typescript
expect(score).toBe(14)
```

Tests that already use hardcoded values (weight=100 → 101, daysIgnored → 1/26/101, dollarValue=0 → 27) are fine — leave them.

### IMPORTANT
This must be done BEFORE changing the formula. Pin the current values first. Then when the formula changes, the pins will catch it and Nik approves the new values.

---

## GLOBAL TEST RULE — applies to ALL pinning tests in this project

Every pinning test MUST import the real value from the source module and assert it against a hardcoded literal. No helper functions that mirror the implementation. No local variables that duplicate the value. The test must break if the source value changes.

**Correct:**
```typescript
import { DEFAULT_INSTANT_URGENCY_THRESHOLD } from './morning-brief'
expect(DEFAULT_INSTANT_URGENCY_THRESHOLD).toBe(9)
```

**Wrong:**
```typescript
const EXPECTED_THRESHOLD = 9
expect(EXPECTED_THRESHOLD).toBe(9)  // tests nothing — always passes
```

This rule applies to all four pinning test files:
- `src/lib/db/actions.test.ts`
- `src/services/lead-tracking.test.ts`
- `src/services/threading.test.ts`
- `src/lib/supabase/defaults.test.ts`
- `src/services/morning-brief.test.ts`

---

## SCORING — Formula change (separate task, needs Nik's decision)

### Problem
Log compression flattens above-anchor deals. 45M (9x high anchor) scores only 23.5 instead of 34+. The original intent was Fibonacci-like growth where above-anchor deals keep climbing steeply.

### Current behavior (log)
```
500K (low anchor)  → normVal  2
5M   (high anchor) → normVal 13
10M  (2x high)     → normVal 16.3
25M  (5x high)     → normVal 20.5
45M  (9x high)     → normVal 23.5
100M (20x high)    → normVal 27.3
```

### Desired behavior (Fibonacci-like)
```
500K (low anchor)  → normVal  2
5M   (high anchor) → normVal 13
10M  (2x high)     → normVal ~18-21
25M  (5x high)     → normVal ~28-34
45M  (9x high)     → normVal  34+ (at LEAST)
100M (20x high)    → normVal ~45-55
```

### Options for Nik to choose
**Option A — Power curve (sqrt-family):** `(dollarValue/kcLow)^0.45` scaled so low→2, high→13. Naturally extends: 9x high → ~39. Smooth, no tiers.

**Option B — Piecewise:** Below high anchor: keep current log (compresses small deals, which is fine). Above high anchor: switch to steeper curve (linear or power) so above-anchor deals keep climbing.

### Implementation notes
- Whichever option: four independent terms stay (normVal + urgency + daysIgnored² + weight)
- sellerMultiplier stays post-normalization
- kcLowValue / kcHighValue anchors stay user-configurable
- Pinning tests in `actions.test.ts` must be updated with Nik-approved values AFTER formula change
- Update CLAUDE.md priority scoring section to match

---

## Implementation order

1. **Scoring tests** — fix `actions.test.ts` to use hardcoded values (prerequisite, no behavior change)
2. **Bug 1** — instant notify urgency threshold (smallest change, highest user impact, independent)
3. **Bug 2** — hold/text verification (prevents wrong calendar entries)
4. **Bug 3** — wire up batch optimizer (largest change, depends on scheduling being stable)
5. **Scoring formula** — after Nik decides approach, update formula + pinning test values

---

## Files touched (summary)

| File | Bugs |
|------|------|
| `src/lib/db/actions.ts` | Bug 1 (query), Scoring (formula + tests) |
| `src/lib/db/actions.test.ts` | Scoring (fix fake pins) |
| `src/services/morning-brief.ts` | Bug 1 (threshold), Bug 3 (wire optimizer) |
| `src/services/planning.ts` | Bug 2 (hold/text verification) |
| `src/services/scheduling.ts` | Bug 3 (optimizer fixes) |
| `CLAUDE.md` | Scoring (update docs after formula change) |
