# Planned Features

## Vacation Pause

**Status:** Planned
**Priority:** Medium

### Problem
When a user is on vacation, Mila continues to ingest emails/WhatsApp, generate action proposals, and send morning/afternoon briefs. This creates noise — the user returns to a pile of stale proposals generated while they were away.

### Detection
Mila already detects vacation events via `personal_event_keywords` (`dovolená`, `vacation`, `holiday`). These events block calendar time and don't generate action proposals.

The new logic extends this: when a vacation/holiday event spans one or more full days (all-day event or multi-day range), Mila should enter **pause mode** for that user.

### Proposed Behavior

| Component | During Vacation | Notes |
|-----------|----------------|-------|
| Email ingestion | **Continues** | Messages still sync so nothing is lost |
| WhatsApp ingestion | **Continues** | Same — messages still captured |
| Action proposal generation | **Paused** | No new proposals created (planning step skipped) |
| Lead tracking | **Paused** | No stale-lead follow-ups generated |
| Morning/afternoon briefs | **Paused** | No emails sent to user |
| Calendar sync | **Continues** | Events still tracked for return |

### Implementation Notes

1. **New user setting:** `vacation_pause_enabled: boolean` (default `true`) — lets user opt out if they want briefs during vacation
2. **Detection logic:** In `agent.ts` pipeline (before Step 5) and in `morning-brief.ts`, check if user has an active vacation event covering the current time
3. **Vacation event criteria:**
   - Title matches vacation keywords (`dovolená`, `vacation`, `holiday`, `PTO`, `out of office`)
   - Event is all-day OR spans > 4 hours
   - Event covers "now" in user's timezone
4. **Resume:** Automatic — when vacation event ends, normal processing resumes on next agent run
5. **Brief catch-up:** On first brief after vacation, include a summary of what accumulated (X new emails, Y conversations updated, Z leads went cold)

### Open Questions
- Should Mila send a single "welcome back" brief on return with accumulated highlights?
- Should there be a manual pause toggle (independent of calendar detection)?
- Should auto-replies be sent to incoming emails during vacation? (Requires Gmail send permission)
