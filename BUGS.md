# Mila Bug Tracker

Last updated: 2026-03-15

## Recently Fixed (this session — ready for testing)

### BUG-001: Urgency inflation — all actions scored 7+
- **Status**: FIXED (commits ad1f9c9, 28caa13)
- **Symptom**: Every action came back with urgency 7+ regardless of actual time pressure. Even soft phrases like "this week" scored 7.
- **Root cause**: (a) The urgency scale treated any "this week" mention as a hard deadline worth 7. (b) Enrichment paraphrased deadline language into Czech, losing the original phrasing — so proposeAction couldn't tell if the source said "by Friday" (hard) or "sometime this week" (soft).
- **Fix v1** (ad1f9c9): Added concrete business-day anchors to the scale.
- **Fix v2** (28caa13): Two changes — (1) enrichment now QUOTEs the verbatim original deadline phrase and classifies it as HARD DEADLINE vs SOFT REFERENCE; (2) proposeAction requires a HARD deadline (specific day or consequence) for 7+, soft references cap at 5, no deadline language defaults to 2.
- **Files**: `src/lib/ai/gemini.ts`

### BUG-002: Per-message action spam — duplicate actions per conversation
- **Status**: FIXED (commit ad1f9c9)
- **Symptom**: A conversation with 5 inbound messages would generate 5 near-identical REPLY actions.
- **Root cause**: The `proposeAction()` prompt framed things per-message ("every inbound message deserves a response"), so the AI proposed an action for each message.
- **Fix**: Reframed prompt to conversation-first reasoning — AI now assesses the conversation arc (how we got here → where things stand → what to do next). Multiple actions only when genuinely independent tasks exist.
- **Files**: `src/lib/ai/gemini.ts`

### BUG-003: Timezone offset — scheduling broken on non-UTC servers / DST transitions
- **Status**: FIXED (commit 2c66aa7)
- **Symptom**: Scheduled meeting times were off by 1-2 hours on dev machines or during DST transitions.
- **Root cause**: `getTimezoneOffset()` in scheduling.ts used `toLocaleString()` → `new Date()` round-trip, which depends on server's local timezone. Worked on Vercel (UTC) by accident. Two separate `Date()` calls could straddle a DST boundary.
- **Fix**: Replaced with `Intl.DateTimeFormat` using `shortOffset` to get Prague's real UTC offset directly. Correct regardless of server timezone and DST-safe.
- **Files**: `src/services/scheduling.ts`

## Previously Fixed (deployed)

### BUG-004: Agent lock blocks all runs when table missing
- **Status**: FIXED (commit c8d5199)
- **Symptom**: Agent never ran — every invocation returned "concurrent run already in progress."
- **Root cause**: `tryAcquireUserLock()` treated ALL DB errors as "lock held" (returned false). If `user_agent_locks` table didn't exist, every run was blocked.
- **Fix**: Only return false on error code 23505 (actual unique constraint violation). Any other error logs a warning and returns true (fail-open) so the agent runs.
- **Files**: `src/lib/db/locks.ts`

### BUG-005: classifyEmail silent data loss — zero emails ingested
- **Status**: FIXED (commit 9e05fa0)
- **Symptom**: Agent ran successfully but ingested 0 emails. No errors logged.
- **Root cause**: When AI returned JSON without `isActionable` field, `parsed.isActionable` was `undefined`. `!undefined === true`, so every email was silently marked non-actionable and skipped.
- **Fix**: Changed to `isActionable === true` (strict equality) with category fallback.
- **Files**: `src/lib/ai/gemini.ts`

### BUG-006: Trigger pixel blocking agent runs
- **Status**: FIXED (commits b1fd5c9, c0bf8f2)
- **Symptom**: Agent runs sporadically blocked after user opened brief emails.
- **Root cause**: Trigger pixel in brief emails fired `runAgentForUser()` fire-and-forget, which grabbed the in-memory lock and blocked subsequent scheduled agent runs.
- **Fix**: Removed trigger pixel from brief email template. Trigger route now returns GIF only (no agent run) so old emails don't 404. QStash polling replaced this mechanism.
- **Files**: `src/services/morning-brief.ts`, `src/app/api/trigger/[userId]/route.ts`

### BUG-007: Priority system — removed dead complexity
- **Status**: FIXED (commit b8d358a)
- **Symptom**: `classifyEmail()` returned a high/medium/low priority field that was stored but never used in scoring. `pain_factor` column existed but was always null.
- **Fix**: Removed priority field from AI prompt, return type, and all consumers. Removed `pain_factor` from Supabase types. Numeric `priority_score` (calculatePriorityScore) unchanged.
- **Files**: `src/lib/ai/gemini.ts`, `src/services/planning.ts`, `src/services/ingestion.ts`, `src/services/bulk-ingestion.ts`, `src/lib/supabase/types.ts`

## Pre-Pilot Verification Checklist

### VERIFY-001: Agent lock — RESOLVED (drop lock, widen polling)
- **Decision**: Drop the agent lock entirely. Change QStash agent polling from 5 minutes to 10 minutes.
- **Rationale**: The lock solved a theoretical problem. Agent runs take 1-3 minutes; Vercel kills them at 5 minutes (`maxDuration: 300`). With 10-minute polling, even a worst-case run finishes with 5 minutes to spare — no overlap is possible. Planning-level dedup (`getPendingActionTypes` in `planning.ts:108`) provides a safety net regardless.
- **Tradeoff**: Emails sit up to 10 minutes before Mila sees them (was 5). Urgent notifications (urgency >= 9) take up to ~15 minutes end-to-end (agent poll + instant-notify poll). Neither is "instant" — both are fine for real estate workflows.
- **Lock code**: `src/lib/db/locks.ts` and its test can stay (no harm) or be removed later. The lock was removed from `agent.ts` in commit `1c56568` (accidentally bundled with three unrelated fixes). It will not be re-wired.
- **Action**: Update QStash agent schedule to `*/10 * * * *` when configuring production.

### VERIFY-002: Embedding failure visibility
- **Status**: VERIFIED — was broken, now fixed
- **Finding**: Embedding failures WERE still silent. Header comment in `generate.ts` falsely claimed "the app works without embeddings." Ingestion bundled enrichment + embedding in one try/catch — couldn't tell which failed. Threading logged a generic message.
- **Fix**: (1) Deleted false header comment in `generate.ts`. (2) Separated enrichment and embedding try/catch in `ingestion.ts` (inbound + outbound). (3) All embedding failures now log `[Embeddings] FAILED` with message ID for Sentry filtering. (4) Updated CLAUDE.md to reflect that embeddings are critical, not optional.
- **Files**: `src/lib/embeddings/generate.ts`, `src/services/ingestion.ts`, `src/services/threading.ts`, `CLAUDE.md`

### VERIFY-003: WhatsApp group message handling
- **Status**: TO VERIFY
- **What**: `scripts/whatsapp-daemon.ts` line 303 has `if (jid.endsWith('@g.us')) continue` — group messages are dropped entirely. SPEC and CLAUDE.md describe group support (extract participant ID, prepend group name). The group handling code was never written.
- **Impact**: Low for pilot (1:1 messages work), but needs to be built if pilot user uses WA group chats for deals.

## Known Issues (not yet fixed)

### BUG-008: Calendar events not linking to conversations
- **Status**: OPEN
- **Symptom**: Calendar invitations detected by calendar-ingestion don't always create a linkage to the relevant email conversation about the same meeting.
- **Impact**: Medium — Mila may propose a SCHEDULE action for a meeting that's already on the calendar.

### BUG-009: WhatsApp group message attribution
- **Status**: OPEN
- **Symptom**: In group chats, messages from different participants can be attributed to the group phone number rather than individual senders, confusing CP identification.
- **Impact**: Low — affects multi-party WhatsApp group chats only.

### BUG-010: Embedding failures not surfaced
- **Status**: FIXED (VERIFY-002)
- **Symptom**: When embedding generation fails (Gemini API error), it was caught silently. Enrichment and embedding shared one try/catch — couldn't distinguish which failed.
- **Fix**: Separated try/catch blocks. All failures now log `[Embeddings] FAILED` or `[Enrichment] FAILED` with message ID. Visible in Sentry.
- **Future consideration**: Embedding fallback strategy — dual-embed with second provider for instant failover. Flagged for decision before significant conversation volume exists.

---

*To test fixes BUG-001 through BUG-003, run the agent and check:*
1. *Urgency scores — should see a spread (1-10) with most routine items at 3 or below*
2. *Action count — should be ~1 per conversation, not 1 per message*
3. *Scheduling times — should be correct in Europe/Prague regardless of server TZ*
