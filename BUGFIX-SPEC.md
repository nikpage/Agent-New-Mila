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

## BUG 3 — Batch optimizer is dead code

### Problem
`optimizeScheduleActions()` exists in `scheduling.ts:676-802`, is exported, has 7 passing tests, but is NEVER called from production code. Meetings scheduled in the same planning batch (concurrency of 5) each call `proposeMeeting()` independently and don't see each other's holds. This caused an unrelated meeting to be scheduled at 10:05am — only 5 minutes after another meeting — violating the 15-minute `meeting_buffer_minutes`.

### Fix

**File: `src/services/morning-brief.ts` — `sendMorningBrief()`**

1. Import `optimizeScheduleActions` from `@/services/scheduling`
2. Call `optimizeScheduleActions(userId)` BEFORE building the `briefActions` array (after line 48, before line 60)
3. The optimizer's `OptimizeResult.holds` and `moveSuggestions` should inform the brief rendering

**File: `src/services/scheduling.ts` — `optimizeScheduleActions()`**

4. **Skip already-scheduled actions:** Check if action's `payload.hold_event_id` exists. If it does, the action was already scheduled during planning — skip it in the optimizer. Don't create a second hold.

5. **Fix stale slot list:** Currently `findBestSlots()` is called once at the top (line 692). As holds are created in the loop, subsequent iterations don't know about them. Fix: either re-query after each hold, or maintain a local list of booked time ranges and filter against it.

6. **Fix buffer-blind dedup:** `usedSlotTimes` (line 695) is a Set of ISO start-time strings. It only prevents exact same-start collisions, NOT buffer violations. Replace with a list of booked time ranges `{ start: Date, end: Date }`. Before booking a new slot, check that it doesn't overlap with any booked range AND respects `meeting_buffer_minutes` on both sides.

### Test impact
- Existing 7 tests in `scheduling.test.ts` cover the optimizer logic
- Add test: action with existing `hold_event_id` in payload is skipped by optimizer
- Add test: two meetings in same batch respect `meeting_buffer_minutes` gap
- Add integration-level test: `sendMorningBrief` calls `optimizeScheduleActions` before building brief

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
