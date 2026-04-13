# CLAUDE.md — Project Guide for Claude Code

## RULES

Role: Strict Senior Developer.

Propose plans; code ONLY after explicit approval.

Execute agreed logic exactly. Zero improvisation.

If logic is flawed: skip/flag minor issues, or halt for critical blockers.

Prioritize architecture. Never introduce tech debt for quick fixes.

Answer questions from what's already in context FIRST. Do NOT launch agents or read files to answer a question when the answer is visible in the conversation. Agents cost tokens — only use them when the information genuinely isn't available.

- NEVER modify expected values in pinning tests (files: `actions.test.ts`, `lead-tracking.test.ts`, `threading.test.ts`, `defaults.test.ts`, `action-card-disable.test.ts`, `instant-notify-grouping.test.ts`, `draft-payload.test.ts`, `address-inference.test.ts`). If a pinning test fails, REPORT the failure and WAIT. Do not update the test to match new output

## Base URLs & Testing
- **Local**: `http://localhost:3000`
- **Prod**: `https://mila.specialagents.pro/`

### Test commands (always local first, then prod)
```bash
# Local
curl "http://localhost:3000/api/cron/morning-brief?userId=ee23bcb7-ee2c-4e3f-a686-fb955ba0d753" -H "Authorization: Bearer $CRON_SECRET"

# Prod
curl "https://mila.specialagents.pro/api/cron/morning-brief?userId=ee23bcb7-ee2c-4e3f-a686-fb955ba0d753" -H "Authorization: Bearer $CRON_SECRET"
```

## Project Overview
Mila is an AI-powered executive assistant that ingests emails, WhatsApp messages, and calendar events, uses Gemini AI to propose actions (reply, schedule, follow up, delegate, snooze), tracks leads, and presents everything for user approval via morning brief emails.

- **Stack**: Next.js 14 (App Router) / TypeScript 5.7 (strict) / Supabase / Tailwind CSS 3
- **AI**: Google Gemini (primary) via @google/generative-ai + Anthropic Claude (fallback) via @anthropic-ai/sdk
- **Deployment**: Vercel (briefs scheduled via Upstash QStash)
- **Monitoring**: Sentry error tracking (client + server + edge)
- **Path alias**: `@/*` → `src/*`
- **Full product spec**: See SPEC.md

## Commands
```bash
npm run build        # Production build (the primary check — catches type errors + lint)
npm test             # Run Vitest test suite (~517 tests across 32 files)
npm run typecheck    # TypeScript only: tsc --noEmit
npm run lint         # ESLint via next lint
npm run dev          # Dev server (uses 8GB heap)
npm run test:watch   # Vitest in watch mode (re-runs on file change)
npm run test:coverage # Vitest with v8 coverage report
```

After making changes, run `npm test && npm run build` to verify nothing is broken.

## Architecture Map
```
src/
├── app/                        # Next.js App Router (pages + API routes)
│   ├── api/agent/dispatch/     # Dispatcher — checks all users for new Gmail activity, fans out agent runs via QStash
│   ├── api/agent/run/          # Main agent orchestration endpoint (triggered by dispatcher via QStash)
│   ├── api/action/[id]/        # Action CRUD + execute/draft/todo/blacklist
│   ├── api/auth/               # OAuth connect + callback
│   ├── api/brief/[userId]/     # Brief card UI (refresh, reschedule-event)
│   ├── api/commands/           # Command execution API
│   ├── api/cron/morning-brief/ # Brief endpoint (called by QStash per-user schedules)
│   ├── api/cron/instant-notify/ # Instant high-priority notification polling
│   ├── api/gdpr/delete/        # GDPR Art. 17 — soft-delete user data
│   ├── api/gdpr/export/        # GDPR Art. 15 — export all user data as JSON
│   ├── api/ingest/             # Manual email/calendar ingestion
│   ├── api/ingest/bulk/        # Bulk historical ingestion orchestrator (QStash on Vercel, NDJSON locally)
│   ├── api/ingest/bulk/worker/ # QStash worker — processes Phase 1–4 in chained batches of 5
│   ├── api/backfill/action/    # Backfill report action handler (allow/blacklist/add/setrole)
│   ├── api/health/             # Health check
│   ├── api/superadmin/stats/   # Superadmin stats API
│   ├── api/todo/[id]/complete/ # Todo completion endpoint
│   ├── api/trigger/ingest/     # Trigger-based ingestion
│   ├── api/whatsapp/status/    # WhatsApp daemon status proxy
│   ├── action/[id]/            # Action detail + edit pages
│   ├── auth/                   # OAuth connect + callback pages
│   ├── brief/[userId]/         # Brief view page
│   ├── superadmin/             # Superadmin dashboard page
│   └── page.tsx                # Home/status dashboard
│
├── shared/                     # Shared pure business logic (prevents cross-service coupling)
│   ├── scoring.ts              # selectOfferMultiplier, computeDaysIgnored
│   ├── scoring.test.ts         # 11 tests pinning shared scoring behavior
│   ├── deal-types.ts           # validateDealType
│   └── index.ts                # Barrel re-exports
│
├── services/                   # Business logic (orchestration layer)
│   ├── agent.ts                # Main pipeline — 8-step orchestration (parallel ingestion)
│   ├── scheduling.ts           # Calendar slot finding (1538 lines) ⚠️ LARGEST
│   ├── planning.ts             # Action generation with channel detection (parallel batches of 5)
│   ├── threading.ts            # Conversation assignment (timeline-based: external thread ID → CP count → density heuristic → AI)
│   ├── ingestion.ts            # Email ingestion (parallel batches of 5)
│   ├── bulk-ingestion.ts       # Historical backfill — 5-phase: fetch → enrich → thread → classify → report
│   ├── backfill-report.ts      # "Welcome to Mila" report email after bulk ingestion (772 lines)
│   ├── calendar-ingestion.ts   # Calendar sync + personal event filtering
│   ├── lead-tracking.ts        # Cooling/cold/dead lead detection (parallel batches of 10)
│   ├── morning-brief.ts        # Daily summary email + instant notifications (1049 lines)
│   └── reflection.ts           # Journal observation extraction from conversations
│
├── lib/                        # Shared utilities & integrations
│   ├── db/                     # Supabase CRUD — 14 files, ~3800 lines total
│   ├── google/                 # Google APIs — calendar, gmail, auth, maps
│   ├── supabase/               # Client + types (types.ts = 949 lines)
│   ├── ai/
│   │   ├── gemini.ts           # AI functions (preFilter, classify, enrichMessage, triageConversation, verifyTriage, etc.)
│   │   ├── mila-voice.ts       # Centralized Mila text generation — ALL user-facing + CP-facing text
│   │   ├── runner.ts           # runAITask() with 2-model fallback + 429/503 retry
│   │   ├── context.ts          # AI context utilities
│   │   └── providers/          # gemini.ts (multi-key rotation), gemini-keys.ts, anthropic.ts, types.ts, index.ts
│   ├── qstash/
│   │   └── client.ts           # QStash per-user brief scheduling (morning + afternoon)
│   ├── whatsapp/
│   │   ├── types.ts            # WAIncomingMessage, WASendRequest, normalizePhoneNumber, etc.
│   │   ├── sender.ts           # sendWhatsAppMessage(), getWhatsAppStatus() — talks to daemon
│   │   └── index.ts            # Barrel re-export
│   ├── commands/
│   │   ├── parser.ts           # isMilaCommand, classifyCommand — pure detection + classification
│   │   ├── executor.ts         # executeCommand — AI-parsed execution (new_contact, todo)
│   │   └── index.ts            # Barrel re-export
│   ├── embeddings/
│   │   └── generate.ts         # cleanMessageText (channel-aware), cleanEmailText, generateEmbedding, generateMessageEmbedding, generateConversationEmbedding
│   ├── crypto.ts               # OAuth token encryption/decryption (81 lines)
│   ├── auth/
│   │   ├── tokens.ts           # OAuth state, action tokens, cron validation, trigger tokens, backfill tokens
│   │   └── api.ts              # API key verification middleware
│   └── holidays.ts             # Holiday calendar
│
├── components/                 # React components
│   ├── action/ActionCard.tsx   # Main action UI (460 lines)
│   ├── action/EditForm.tsx     # Action editor (228 lines)
│   ├── action/SuccessOverlay.tsx # Post-action success animation (103 lines)
│   ├── action/action-card-template.ts # HTML template for action card emails (416 lines)
│   ├── brief/                  # Brief UI components (BriefCard, BriefFeed, ScheduleCard, ReplyCard, TodoCard, etc.)
│   └── ui/                     # Button, Card, Badge, Input
│
├── config/
│   ├── client.ts               # Per-client config (identity, business, AI persona, leads, WA, calendar, scoring)
│   ├── ai-models.ts            # 14 AI stages × 2-model fallback chains
│   └── theme.ts                # Design tokens
│
├── contexts/                   # React contexts (ThemeContext)
├── hooks/                      # React hooks (usePressState)
└── __tests__/                  # Top-level e2e + smoke tests
```

**Additional top-level directories** (outside src/):
```
scripts/
├── whatsapp-daemon.ts          # Standalone Baileys multi-session WA daemon (excluded from tsconfig)
├── configure-user.ts           # User setup script
├── add-user.ts                 # Add user script
├── cleanup-mila-calendar.ts    # Calendar cleanup
├── cleanup-test-calendar.ts    # Test calendar cleanup
├── create-instant-notify.ts    # Instant notify schedule setup
├── eval-triage.ts              # Triage evaluation script
├── bulk-ingest.sh              # Bulk ingestion helper
├── run-agent.sh                # Agent runner helper
├── health-check.sh             # Health check script
└── e2e-test.ts                 # E2E test runner
```

## Shared Business Logic (src/shared/)
Pure functions used by multiple services. Extracted to prevent the circular regression loop where fixing one service would break another.

**Import rule: services import from `shared/`, `lib/`, and `config/`. Orchestrators (agent.ts, morning-brief.ts) import other services. Peer services (e.g. planning, lead-tracking, threading) do NOT import from each other.** This prevents regression cascading between peer services.

| File | Functions | Previously in | Used by |
|------|-----------|---------------|---------|
| `scoring.ts` | `selectOfferMultiplier(cpRole, sellerMul, buyerMul)` | planning.ts | planning, lead-tracking |
| `scoring.ts` | `computeDaysIgnored(latestInboundTimestamp, conversationCreatedAt)` | planning.ts + lead-tracking.ts (duplicated, diverged) | planning, lead-tracking |
| `deal-types.ts` | `validateDealType(value)` | planning.ts | planning, threading |

**computeDaysIgnored**: Single source of truth for "days since last CP contact". Fallback chain: `latestInbound.occurred_at` (from `deal_timeline`) → `conversation.created_at` → `now`. Uses `created_at` (not `last_updated`) because `last_updated` resets on every summary rebuild. Clamps to `Math.max(0, ...)`. Both planning and lead-tracking now use `getLatestInboundFromCP()` from `@/lib/db/timeline` instead of `getLatestMessageFromCP()` from messages — this means phone calls and voice notes reset the "days ignored" counter.

**Why this exists**: Before extraction, planning.ts fell back to `conversation.last_updated` while lead-tracking.ts fell back to `conversation.created_at`. This divergence caused a fix-A-break-B cycle — fixing the calculation in one service left the other stale.

## Agent Dispatcher (src/app/api/agent/dispatch/route.ts)
A global QStash schedule (`*/5 * * * *`, schedule ID `scd_6hCJK1oH54Qa6jHLwRBHb2AiUtzL`) hits `GET /api/agent/dispatch` every 5 minutes. The dispatcher:

1. Fetches all active users with credentials (single Supabase query via `getUsersWithEmailEnabled()`)
2. Calls Gmail `history.list(startHistoryId)` per user in parallel batches of 100 — cost: 2 quota units per user
3. For users with new mail: publishes a QStash message to `POST /api/agent/run` with staggered delivery (1s intervals to limit Supabase connections)
4. Updates `last_checked_at` for all checked users, `last_activity_at` for users with new mail
5. If >1000 users: chains to itself with `offset` param for the next page

**Key fields** (on `users` table):
- `gmail_history_id` — Gmail incremental sync cursor, written by agent run after successful ingestion
- `last_checked_at` — last time dispatcher checked this user
- `last_activity_at` — last time new mail was detected

**Auth**: CRON_SECRET (same as other cron endpoints). **No per-user setup needed** — new users are automatically included.

## Agent Pipeline (src/services/agent.ts)
```
Step 1: Verify user exists + has Google credentials (early return if fail)
Step 0: purgeUserAsCp — remove any CP records matching user's own identity (user can't be their own counterparty)
Step 0.5: Load journal entries + expire temporal entries
Steps 2 + 2.1 + 2.5 run IN PARALLEL (Promise.allSettled):
  Step 2: Ingest inbound emails from Gmail (clean → enrich → embed → write to deal_timeline)
  Step 2.1: Ingest outbound emails from Gmail (clean → enrich → embed → write to deal_timeline)
  Step 2.5: Sync Google Calendar events, detect invitations, filter personal events
Step 3: Get all unassigned timeline entries (deal_timeline WHERE conversation_id IS NULL)
Step 4: Assign timeline entries to conversations (external thread ID → CP count → density heuristic → AI)
Step 4.5: Force-rebuild conversation summaries for all updated conversations (threading only rebuilds after 5 new messages, but planning needs fresh summaries even after 1)
Step 5: Generate action proposals via 2-call triage pipeline: triageConversation (flash with thinking — receives enrichment data + conversation summary, decides needs_action/type/urgency/venue/time) → verifyTriage (flash-lite, cross-checks justification against source message). Venue/time indices from triage are validated against enrichment data via code gates in planning.ts. If triage returns revisit_at, conversation is snoozed until that date. Channel-aware, batched ×5. Note: extractMessageFacts() exists in gemini.ts but is unused dead code — not called by planning.ts.
Step 6: Lead tracking — scan all conversations for cooling/cold/dead leads (batched ×10). Ignores conversations where current_date < snooze_until. Skips service CPs entirely. Uses deal_timeline for activity detection (phone calls reset the counter).
Step 7: Reflection — run runReflection() to extract journal observations from conversations.
```

Result type includes: emailsIngested, whatsappMessagesProcessed, calendarEventsSynced, calendarInvitationsDetected, messagesProcessed, conversationsUpdated, actionsGenerated, followUpsGenerated, coolingLeads, coldLeads, reflectionObservations, replyDraftsGenerated.

### Action Deduplication
One conversation should not produce duplicate action cards across pipeline runs. If an action was proposed in a previous brief and the agent hasn't acted on it, it carries forward — not duplicated. If new information changes the proposed action, the card updates.

**Event-based dedup**: `hasActiveEventForConversation` only counts future events (past events don't block new SCHEDULEs). When both an active event AND a pending SCHEDULE action exist, the pending action's urgency governs dedup — holds are supersedable by higher-urgency proposals. Only confirmed events with no pending action block with Infinity.


### Execution & Agent Actions
When the agent approves an action:
- **REPLY**: Mila generates the draft (if not already generated via the edit workflow), sends the email or WhatsApp message.
- **SCHEDULE**: Hold becomes confirmed. Invite sent to counterparty. Travel buffer booked.
- **TODO**: Logged with due date.

The agent can also:
- **Dismiss** — remove from queue entirely (`dismissAction` in actions.ts)
- **Defer** — reappear in next brief
- **Blacklist** — block a counterparty from future action proposals (`/api/action/[id]/blacklist`)

## Performance Rules (CRITICAL)

### Do NOT bulk-read directories
Never read all files in a directory sequentially. This bloats context and causes hangs.

Worst offenders (do NOT read all files in these):
- `src/lib/db/` — 14 files, ~3800 lines. Use the index below to pick the right file.
- `src/services/` — 12 files, ~5500 lines. Read only the service relevant to the task.
- `src/lib/google/` — 5 files, ~1600 lines. Read only the API you need.

### Do NOT follow imports into large type files
`src/lib/supabase/types.ts` (949 lines) — Only read if you need specific type definitions. Use Grep to find the type you need instead.

### Strategy for understanding code
1. Start with Grep to find the function/type you need
2. Read only the specific file containing it
3. Never read more than 2-3 files from the same directory in one session
4. If you need broader context, use the Explore agent — it manages its own context

## src/lib/db/ Quick Reference
Instead of reading these files, use this index:

| File | Contents |
|------|----------|
| users.ts | getUserById, getUserByEmail, upsertUser, getUserSettings, updateUserSettings, getUsersWithEmailEnabled, getUsersDueBrief, updateUserGoogleTokens, getUserGoogleTokens, updateUserHistoryId, updateUsersLastChecked, updateUsersLastActivity |
| counterparties.ts | normalizeGmailAddress, isSameGmailAddress, purgeUserAsCp, getCPById, getCPByIdentifier, getCPsByIds, getCPsForUser, getCPByPhone, upsertCP, findOrCreateCP, updateCP, blacklistCP, getCPState, updateCPState |
| conversations.ts | getConversationById, getConversationsForUser, createConversation, updateConversation, updateConversationSummary, incrementMessageCount, getMessagesForConversation, getRecentMessages, addParticipant, getParticipants, findConversationByExternalThread |
| messages.ts | getMessageById, getMessageByExternalId, messageExists, createMessage, createMessages, updateMessage, getMessagesInRange, getUnprocessedMessages, assignMessageToConversation, getLatestMessageFromCP, countMessagesInConversation |
| actions.ts | getActionById, getActionsForUser, getPendingActionsForBrief, getRecentlyCompletedActions, createAction, updateAction, updateActionStatus, approveAction, completeAction, dismissAction, dismissAllPendingActions, updateActionDraft, markActionsNotified, getHighPriorityUnnotifiedActions, markActionsInstantNotified, calculatePriorityScore, getActionsForConversation, hasPendingAction, getPendingScheduleActions, getPendingActionsByType, hasPendingActionForCP |
| todos.ts | getTodoById, getTodosForUser, getPendingTodos, createTodo, updateTodo, completeTodo, deleteTodo, getTodosForThread, getOverdueTodos, getTodosDueToday |
| events.ts | getEventById, getEventsInRange, getEventsForToday, getUpcomingEvents, createEvent, updateEvent, deleteEvent, findConflicts, getLastEventLocation, getEventsWithCP, findAvailableSlots, getEventsByBlockGroup, cleanupBlockGroup, createHoldEvent, createTravelBuffer, cleanupTravelBuffers, getTravelBuffers, confirmEvent, cancelEventWithCleanup, calculateEventScore, upsertEventByGoogleId, getChildEvents, hasActiveEventForConversation, rescheduleEvent |
| channels.ts | getOrCreateChannel, getChannelType, getChannelTypes (batch) |
| embeddings.ts | saveMessageEmbedding, saveConversationEmbedding, getConversationsWithEmbeddingsByCP |
| gdpr.ts | writeAuditLog, exportAllUserData, deleteAllUserData, enforceRetentionPolicy |
| journal.ts | Journal entry CRUD — createJournalEntry, getJournalEntries, updateJournalEntry, expireTemporalEntries, etc. |
| timeline.ts | createTimelineEntry, getUnassignedTimelineEntries, assignTimelineEntry, getTimelineForConversation, getTimelineForCP, getLatestInboundFromCP, getRecentDensityByConversation, getTimelineContextForConversations, getOrphanCallLogs, getCoolingConversations |
| locks.ts | tryAcquireUserLock, releaseUserLock |
| index.ts | Barrel re-exports (do not read) |

All db files follow the same pattern: import getSupabaseAdmin from ../supabase/client, import types from ../supabase/types, export async CRUD functions.

**SECURITY**: When adding new queries, always filter by user_id unless specifically needed:
```typescript
// GOOD
const actions = await supabase.from('action_proposals').select('*').eq('user_id', userId)

// BAD (exposes all users' data)
const actions = await supabase.from('action_proposals').select('*')
```

## Per-User Config
All user configuration is stored in `users.settings` JSONB column. See ONBOARDING.md for the full settings reference. Configured via `scripts/configure-user.ts`.

`src/config/client.ts` exports helper functions that take UserSettings as input:
- `getAISystemPrompt(settings)` — builds the AI system prompt from user's identity, locations, and business context
- `containsHighValueSignals(text, settings)` — checks text against user's high-value keywords (used in both planning and lead tracking)
- `isPersonalEvent(title, settings)` — detects personal calendar events

The `clientConfig` const object in this file is legacy dead code — not consumed at runtime. All runtime behavior reads from UserSettings via DB.

## Lead Tracking (src/services/lead-tracking.ts)
Runs as Step 6 of agent pipeline. Scans all conversations, detects stale leads:

| Status | Days Inactive | Action |
|--------|---------------|--------|
| Active | < cooling_threshold_days | None |
| Cooling | cooling–cold threshold | Gentle check-in |
| Cold | cold–dead threshold | Urgent follow-up |
| Dead | ≥ dead_threshold_days | Last-chance contact |

Thresholds are per-user via `settings.cooling_threshold_days`, `settings.cold_threshold_days`, `settings.dead_threshold_days`.

Priority escalation is handled entirely by the `daysIgnored^1.5` factor in the main priority formula — no separate boost multipliers.

**Snooze Bypass**: Ignores any conversation where `current_date < snooze_until`. This prevents Mila from panicking and flagging a deal as "Dead" when it's just sitting in the land registry or waiting on a bank.

**Service CP bypass**: Skips conversations where the primary CP has a service role (`lawyer`, `notary`, `photographer`, `appraiser`, `inspector`, `repair-builder`). Service CPs don't "go cold" — a lawyer who hasn't emailed in 10 days is just not needed yet.

Skips conversations with existing pending actions. Caps at 3 auto follow-ups per conversation — after three unanswered nudges, the deal still appears in lead tracking but Mila stops generating new follow-up actions. Uses `selectOfferMultiplier()` from `@/shared/scoring` to apply seller/buyer role-based multiplier to follow-up priority scores. Uses `computeDaysIgnored()` from `@/shared/scoring` for consistent days-since-contact calculation (same logic as planning). Activity detection uses `getLatestInboundFromCP()` from `deal_timeline` — phone calls and voice notes count as activity. High-value conversations (matching `highValueSignals`) are flagged to the AI during planning for better dollar value estimation.

## Database Schema
Full schema reference (all tables, columns, deal property model, migrations): See docs/SCHEMA.md

Key tables: users, cps, channels, conversation_threads, messages, deal_timeline, action_proposals, events, todos, emails, audit_logs, user_agent_locks. All tables have user_id — always filter by it in queries. The `channels` table maps channel UUIDs to types ('email', 'whatsapp', etc.) — `messages.channel_id` is a UUID FK to `channels.id`. The `deal_timeline` table is the chronological record of all CP interactions (emails, WhatsApp, calls, voice notes) — see Deal Timeline section below.

The `users` table includes dispatcher fields: `gmail_history_id` (Gmail sync cursor, written by agent run), `last_checked_at` (last dispatcher poll), `last_activity_at` (last time new mail detected).

Conversation statuses are stored in `conversation_threads.status`: active or archived. Snoozed deals remain active — `snooze_until` suppresses lead tracking temporarily, deal resumes normal monitoring on expiry.

## Priority Scoring
**Formula**: `Score = (nVal × sellerMultiplier) + (urgency × daysIgnored^1.5) + weight`

Three additive terms — deal importance + time pressure + scheduling weight:

- **nVal** = `Math.max(1, Math.round((dollarValue / kcHighValue) * 10))` — Percentage-based normalization capped at a reasonable ceiling. A 5M deal with a 10M high-value anchor gets a base score of 5. Hard floor of 1 ensures no deal ever drops to 0 or negative.
- **sellerMultiplier** — Applied to nVal. Default 1.5 for sellers, 1.0 for buyers (user-configurable via `selectOfferMultiplier()`).
- **urgency × daysIgnored^1.5** — Time pressure. Multiplicative — urgency amplifies the aging curve. ^1.5 provides a strong but manageable curve (Day 1 = 1, Day 3 ≈ 5.2, Day 5 ≈ 11.1, Day 7 ≈ 18.5).
- **weight** — Scheduling immovability (1-10 or 100). Added flat to the score so hard-to-move events rank higher.

These terms are independent. A small urgent deal beats a large routine one. A todo with today's deadline beats a high-value deal that can wait.

### Urgency Scale

| U | Meaning |
|---|---------|
| 10 | Due within 1 hour. Do NOW. |
| 9 | Due within 8 business hours. Do NOW or ASAP. |
| 8 | Due end of business tomorrow. |
| 7 | Due in 2 business days. |
| 6 | Due in 3 business days. |
| 5 | Due in 5 business days. Try before EOD Friday. |
| 4 | Due next week. Try for EOD Friday or next Wednesday. |
| 3 | Due within 2 weeks. Deadline exists but not yet visible. |
| 2 | (unused) |
| 1 | No time pressure. |

**Display thresholds** (user-facing Czech labels in briefs):
- 9–10: "MUSÍŠ to udělat TEĎ" (must do now)
- 7–8: "Měl bys to udělat dnes" (should do today)
- 5–6: "Měl bys to udělat brzy" (should do soon)

**Instant alert trigger**: urgency > 8 (i.e. urgency >= 9). See Instant High-Priority Notifications.

### Slot Defense (W — Immovability)

**weight (W) serves dual purpose: it's added flat to the priority score AND determines how strongly an existing calendar event resists being moved:**
- **1–10**: movable to hard-to-move. A casual viewing might be a 3. A client meeting with a specific requested time might be a 7.
- **100**: effectively immovable. Court dates, notary appointments, personal commitments (doctor, kids' concert, partner's flight). The gap between 10 and 100 is intentional — it creates a hard tier.

W applies to non-deal events too. The agent's life doesn't stop for work.

**Implementation**: `src/lib/db/actions.ts` → `calculatePriorityScore()`

| Input | Scale | Notes |
|-------|-------|-------|
| dollarValue | 0+ (CZK) | Deal/transaction value |
| kcHighValue | default 5000000 | "Big deal" anchor from settings.kc_high_value. Used to calculate nVal. |
| sellerMultiplier | default 1 | From user settings: offer_multiplier_seller (1.5) or offer_multiplier_buyer (1.0) based on CP role |
| urgency | 1-10 | AI-assessed (trusted directly, no post-processing clamp), safe default 1. Prompt includes `urgencyJustification` field as a reasoning aid — forces the AI to cite evidence before assigning urgency. |
| daysIgnored | 0+ | Days since last activity (escalates via ^1.5) |
| weight | 1-10 or 100, default 0 | Added flat to priority score + scheduling immovability. How movable: 1 = easy to reschedule, 10 = hard to move. 100 = absolutely immovable. User events default to 7. |

**Safe defaults**: urgency, sellerMultiplier fallback to 1 if 0/null (prevents score collapse). kcHighValue falls back to 5000000.

**DO NOT REMOVE OR CHANGE** the formula or wiring without explicit user permission.

**Wiring**: Both `planning.ts` and `lead-tracking.ts` import `selectOfferMultiplier` and `computeDaysIgnored` from `@/shared/scoring` — never from each other. Both import `getLatestInboundFromCP` from `@/lib/db/timeline` for activity detection (replaces the old `getLatestMessageFromCP` from messages). Both pass sellerMultiplier (from CP role), kcHighValue (from user settings), and daysIgnored (from shared computation) to `calculatePriorityScore()`. `planning.ts` additionally passes weight (from triage AI response). Lead tracking passes no boost multipliers — escalation is handled entirely by daysIgnored^1.5 via the main formula.

## AI Model Configuration
**Config**: `src/config/ai-models.ts` — 14 pipeline stages, each with 2-model fallback chain (3rd slot reserved but unused).

**Runner**: `src/lib/ai/runner.ts` → `runAITask(stage, prompt)` — auto-cascades on failure, retries 429s and 503s with exponential backoff (1s, 2s, 4s), logs which model succeeded.

**Model selection rule**: Structured JSON output → Gemini. Czech prose output → Claude. This ensures reliable Czech text generation.

| Stage | Purpose | Primary → Fallback1 → Fallback2 |
|-------|---------|--------------------------------|
| filter | Spam detection | gemini-2.5-flash-lite → claude-haiku-4-5-20251001 |
| classify | Email category + priority | gemini-2.5-flash-lite → claude-haiku-4-5-20251001 |
| enrichment | Per-message key info extraction | gemini-2.5-flash → claude-haiku-4-5-20251001 |
| threading | extractTopic, shouldJoinConversation | gemini-2.5-flash → claude-sonnet-4-6 |
| analysis | analyzeConversation | gemini-2.5-flash → claude-sonnet-4-6 |
| triage_extract | extractMessageFacts (pure reading comprehension — what CP said, asked, deadlines, venue, time, questions; temp 0) | gemini-2.5-flash-lite → claude-haiku-4-5-20251001 |
| triage | triageConversation (decision-only — receives verified extraction, not raw email; thinkingBudget 4096) | gemini-2.5-flash → claude-sonnet-4-6 |
| triage_verify | verifyTriage (cross-check justification against source message) | gemini-2.5-flash-lite → claude-haiku-4-5-20251001 |
| drafting | All mila-voice.ts functions (generateFinalDraft, generateBriefIntro, generateSchedulingIntent, generateLeadFollowUpIntent, generateUrgentIntro, generateBriefHeadline, regenerateDraftWithInstruction) | claude-sonnet-4-6 → gemini-2.5-flash |
| reflection | Journal observation extraction | claude-haiku-4-5-20251001 → claude-sonnet-4-6 |
| draft_edit | Gap fill + spell/grammar on save | claude-haiku-4-5-20251001 → claude-sonnet-4-6 |
| contradiction_analysis | Resolve conflicting beliefs | claude-sonnet-4-6 → gemini-2.5-flash |
| contradiction_escalation | Opus fallback for unresolved contradictions | claude-opus-4-6 → claude-sonnet-4-6 |
| belief_audit | Monthly/quarterly full belief review | claude-opus-4-6 → claude-sonnet-4-6 |

**Rate limit handling**: On 429/RESOURCE_EXHAUSTED/503 errors, retries same model up to 3 times with exponential backoff before falling to next model in chain.

**Embedding model**: gemini-embedding-001 (768-dim, multilingual) — separate from chat, NO fallback chain. Embeddings are critical for cross-channel conversation threading. Failures are logged with `[Embeddings] FAILED` prefix for Sentry visibility. Without embeddings, only Gmail thread ID matching works — cross-channel and cross-thread merging is lost.

**Providers**:
- `src/lib/ai/providers/gemini.ts` — @google/generative-ai SDK. Supports multi-key rotation via GEMINI_API_KEYS (comma-separated) — strictly round-robins across keys on every request to spread load. Falls back to single GEMINI_API_KEY if not set.
- `src/lib/ai/providers/anthropic.ts` — @anthropic-ai/sdk. Uses ANTHROPIC_API_KEY env var.

**Prompt language convention**: ALL prompts are written in English. This is consistent across all 9 AI functions because LLMs reason better in English. Output language is controlled via a strict directive injected at the end of the prompt: `CRITICAL: You must generate the final text for the user in ${settings.ai_language}. Do not output English.` This ensures high-quality reasoning with localized output (Czech by default).

**Business context injection**: `getAISystemPrompt()` from `src/config/client.ts` is prepended to `triageConversation()`, `generateFinalDraft()`, and `analyzeConversation()` prompts. Includes: user name/role, company, specialization, market, deal range, office_location, home_location, lawyer_notary, high-value signals, language, tone. This lets the AI resolve contextual references like "your office" or "at the notary" to actual addresses. `enrichMessage()` receives the same location data in its business context line. All AI functions that process user content now receive UserSettings for consistent language and domain interpretation. Channel context (email vs WhatsApp) adjusts tone. `triageConversation` estimates dollarValue and weight (0-100 immovability) in the user's configured currency with typical deal range as reference, and classifies dealType.

**intent_cs formatting**: TODO actions use a numbered checklist (max 4 items, max 6 words each: verb + object). REPLY and SCHEDULE actions use a single sentence (max 20 words). No numbered lists for REPLY/SCHEDULE.

**Address inference for SCHEDULE**: Meeting venue is extracted by `extractMessageFacts()` (triage_extract stage) — the extraction prompt identifies the MEETING VENUE (where people will physically meet), NOT the property/deal subject. Returns `confirmed_venue_index` (index into enrichment addresses) or `confirmed_venue_freetext`. These are code-merged onto the triage result in `planning.ts` — the decision model never picks venues. Geocoding via `validateMeetingLocation()` still runs on the extracted venue. `generateFinalDraft` prompts still enforce venue rules for CP-facing drafts.

**UDĚLAT button disable logic**: Only SCHEDULE actions can have UDĚLAT disabled (when location is missing or unfilled fields exist without a hold event). REPLY, TODO, and all other action types are NEVER blocked — their UDĚLAT is always active. This logic lives in `ActionCard.tsx`, `action-card-template.ts`, and `morning-brief.ts` (both brief and instant-notify HTML renderers).

**Draft endpoint payload writes**: `src/app/api/action/[id]/draft/route.ts` batches all payload field updates (location, is_online, editedTo) into a single write using a freshly fetched payload. This prevents race conditions where sequential writes with stale payload overwrite each other.

### Triage Architecture: Decide → Verify

The triage pipeline is a 2-call process (orchestrated in `planning.ts`):
```
triageConversation()      → TriageResult (decision: needs_action, type, urgency, intent_cs, rationale_cs, venue/time indices)
       ↓
code gates in planning.ts → validate venue_index/time_index against enrichment data, truncate intent_cs
       ↓
verifyTriage()            → binary check: is this action justified or just FYI?
```

**Key design rules**:
- `triageConversation()` receives the latest inbound text, formatted messages, conversation summary, pending actions, CP name, channel, settings, journal, and enrichment data.
- Venue/time indices in the triage result are validated against enrichment addresses/times by code gates (out-of-range → null).
- `verifyTriage()` sees the raw inbound text for independent cross-checking.
- If both a non-SCHEDULE action AND venue/time data exist in the triage result, planning.ts deterministically creates an additional SCHEDULE action.

**Note**: `extractMessageFacts()` exists in `gemini.ts` (stage: triage_extract) but is currently unused — no caller in planning.ts or elsewhere. The `triage_extract` AI stage config remains in ai-models.ts but is dead.

## Deal Timeline (src/lib/db/timeline.ts)

Every communication event between the user and a counterparty is written to `deal_timeline` — a single chronological table. This is the context source for conversation assignment, action proposals, and lead tracking.

**Table**: `deal_timeline` — id, user_id, cp_id, conversation_id (nullable, written after assignment), parent_id (links voice notes to call logs), event_type ('email'/'whatsapp'/'call_log'/'voice_note'), direction ('in'/'out'/'internal'), occurred_at (sort key), ingested_at, content (cleaned text), message_id (FK to messages, nullable), metadata (jsonb).

**Write path**: Email/WhatsApp ingestion writes to both `messages` AND `deal_timeline`. Call logs and voice notes write to `deal_timeline` only (no `messages` row). Filter-skip and non-actionable messages (cp_id = null) do NOT get timeline entries.

**Read path**: Steps 3-6 of the agent pipeline read from `deal_timeline` instead of `messages`. Planning uses timeline entries for context (includes calls and voice notes). Lead tracking uses timeline for activity detection. `messages.conversation_id` is always kept in sync via writeback.

Full spec: See docs/DEAL-TIMELINE-SPEC.md

## Conversation Assignment (src/services/threading.ts)

### Purpose
Unified conversation tracking across channels, email threads, and senders. An email from Jan Novotny, a forwarded email from his assistant, and a WhatsApp from the same Jan — all about the same deal — land in ONE conversation.

### Pipeline
Operates on `deal_timeline` entries (not raw messages):
1. **External thread ID match (fast path)** — if the timeline entry has a linked message with external_thread_id, use `findConversationByExternalThread()`. Same-channel email fast path.
2. **CP conversation count** — count active conversations for this CP. Zero = create new. One = assign immediately. Multiple = proceed to heuristic.
3. **Density/recency heuristic** — count timeline entries per candidate conversation in the last 15 minutes. If one conversation has >= 3 recent entries and the second-highest count is 0, assign without AI.
4. **AI assignment** — feed up to 10 recent timeline entries per candidate conversation to the AI (stage: threading). AI responds with conversation ID or "NEW".
5. **Writeback** — write conversation_id to `deal_timeline` entry and linked `messages` row. Increment message count, add CP as participant.

**Legacy path**: The old embedding-based assignment (cosine similarity with thresholds 0.78/0.55) is preserved as `processMessagesForThreading` for backward compatibility with bulk ingestion.

### Per-message enrichment (enrichMessage in gemini.ts)
- Runs after cleaning, before threading. Extracts: who's involved, property/subject, message kind, deal numbers, core intent.
- **Output language**: Controlled via `CRITICAL` directive at end of prompt using `settings.ai_language` (same pattern as all other AI functions). Enrichment prompt includes business context from UserSettings so domain-specific terms are interpreted correctly (e.g. Czech "statek" = farm/estate, not "ship").
- Saves to `messages.enriched_text` column. Embedding generated from enriched text (not raw body).
- **Stage**: enrichment (gemini-2.5-flash → claude-haiku-4-5-20251001). Cost-sensitive — runs per message.
- Accepts optional UserSettings for business context injection. All callers (ingestion.ts, bulk-ingestion.ts, QStash worker) fetch and pass user settings.
- Runs in both regular ingestion (ingestion.ts) and bulk historical ingestion (bulk-ingestion.ts). Bulk enrichment runs in Phase 2 (Phase2EnrichResult tracks enriched, enrichmentFailed, embedded, embeddingFailed).

**Conversation summaries** (`analyzeConversation` in gemini.ts) use enriched messages (adaptive count: enough to reach ~1500 chars). Falls back to cleaned_text for older un-enriched messages. Embedding generated from summary text. Accepts optional UserSettings — when provided, the AI receives business context and explicit role mapping: [outbound] = user (email account owner), [inbound] = counterparty. All output matches ai_language.

**Deal context narrative**: Each conversation maintains a running narrative — not a message log, but a summary: where the deal stands, how it got there, key facts, and what needs to happen next. This is what appears on action cards so the agent can step back into a deal they haven't thought about in weeks.

## Embeddings
Per-message embeddings (`message_embeddings`) and per-conversation embeddings (`conversation_threads.embedding`) are still generated but are no longer used for conversation assignment. The timeline-based algorithm replaced embedding-based threading. Embeddings remain for potential future semantic search.

### Channel-aware cleaning (cleanMessageText in generate.ts)
- **email/email/gmail**: Full cleaning (signatures, quoted replies, disclaimers, tracking pixels)
- **email/exchange**: Gmail base + Outlook-specific patterns (EXTERNAL EMAIL banners, From/Sent/To headers, aka.ms links)
- **whatsapp**: Minimal — system messages and forwarded labels only

`cleanEmailText()` is a backward-compatible alias for `cleanMessageText(text, 'email')`

## Scheduling & Calendar Management
**Implementation**: `src/services/scheduling.ts` (1538 lines — largest service)

### When the Optimizer Runs
The schedule optimizer runs before ANY action card rendering — briefs, instant notifications, or any future surface. It must see ALL SCHEDULE actions for the user at once to batch-optimize. Never render SCHEDULE cards without running the optimizer first.

### Core Flow — Batch Schedule Optimization
When a brief or instant notification is being prepared, Mila pre-optimizes ALL unsent SCHEDULE actions as a batch:

1. Collects all pending, unsent SCHEDULE actions
2. Optimizes slot selection across all new meetings using these criteria (in priority order):
   - **CP availability** — stated or inferred from conversation (e.g. "I can only do Tuesday afternoon"). **CP-stated times are always respected**, even outside working hours/days. If CP says "Saturday at 9 for the viewing," Mila books it and surfaces it to the user — never silently rejects it. Default slot search (no CP preference) uses working hours/days normally.
   - **User availability** — free slots in the user's calendar (working hours, no conflicts)
   - **Travel optimization** — avoid crossing town twice; cluster meetings geographically when possible while respecting criteria above
   - **Conflict resolution (last resort)** — Mila first tries to schedule without moving existing events. Not accepting a meeting due to time conflict is acceptable in most cases. However, if a new meeting has high priority AND the conversation indicates the CP can only meet at a specific conflicted time, Mila suggests moving the conflicting event — even if it has high weight. The user always has the final call; Mila only suggests, never auto-moves
3. Picks THE optimal slot for each meeting — one slot per meeting, not multiple options
4. Creates a tentative hold event + travel buffer for each chosen slot (prevents double-booking while user reviews)
5. Presents a single batch schedule card in the brief, grouped by day
   - Each sub-card shows: suggested time, CP name, location, deal value, and Mila's reasoning for that slot
   - Standard CTAs per sub-card (UDĚLAT / UPRAVIT / UDĚLÁM SÁM) plus a batch "UDĚLAT VŠE" button
6. On approval: hold becomes confirmed event, invite sent to CP
7. On rejection or edit via UPRAVIT: hold is cleared, new hold created if user picks a different time

**Scope rules**:
- Only touches penciled-in (unsent meetings). Once an invite is sent to CP, that slot is locked — treated as a confirmed event
- Sent invites and confirmed events are fixed walls the optimizer plans around — never auto-moved (but Mila may suggest moving them if conflict resolution requires it)
- For a single SCHEDULE action, the same flow applies — Mila picks the optimal slot and presents it

### Slot Finding
- `findFreeSlots()` scans working hours for gaps between ALL calendar events (including holds)
- Working hours are computed in Prague timezone (Europe/Prague) regardless of server runtime TZ — uses `Intl.DateTimeFormat` + `Date.UTC` offset detection, NOT `setHours()` which would use server-local TZ (UTC on Vercel)
- Respects working_hours_start/end, working_days from user settings
- Applies meeting_buffer_minutes (from user settings) between meetings. MIN_TRAVEL_BUFFER_MINUTES = 15 is the minimum *travel* buffer, separate from meeting_buffer_minutes

### Travel Time
- `calculateTravelForSlot()` uses Google Maps Distance Matrix API (`src/lib/google/maps.ts`)
- Origin: previous event location → office_location → home_location (fallback chain)
- **Same Location / Online**: 0 min buffer.
- **Different Location**: Queries Google Maps API for estimated travel time + adds a flat 10 min safety buffer (for parking/walking to the door).
- Creates travel buffer events linked via parent_event_id
- **Travel buffer is created at hold time** — `blockSlotForProposal()` calls `bookTravelBuffer()` immediately. A hold without travel blocked is a hold the user can't reach. The batch optimizer's `bookedRanges` includes travel buffer start → meeting end so subsequent meetings don't get scheduled in the travel gap.
- At confirmation (`confirmSlot`), tentative travel buffers are cleaned up and recalculated (origin may have changed since hold creation).

### Hold Events
- One hold per meeting — the optimal slot Mila chose
- Includes a travel buffer event (linked via parent_event_id) blocking the travel time before the meeting
- Prevents double-booking between brief generation and user action
- Short-lived: approved → becomes confirmed event. Rejected/edited → cleared
- If user doesn't act by next brief, the hold remains and the brief nudges again

### Priority-Based Conflict Resolution
When a new meeting conflicts with existing events:
- Compares new action's priority against existing event's W (immovability)
- At urgency 9–10, Mila will suggest moving even a W=100 event
- She always presents both sides. The agent decides. Mila never silently moves or drops anything
- `handleConflict()` compares `calculateEventScore()` of new vs existing
- New score > existing score → recommendation: 'move_existing'
- New score ≤ existing score → recommendation: 'suggest_alternate'
- User-created events default weight = 7 (treated as planned but movable for high-value deals)
- Weight is NEVER null — every event has a weight value. Do not add null guards for weight
- Conflict resolution handles rare conflicts with confirmed events — separate from batch optimization
- **Resolution actions** (`/api/action/[id]/resolve-conflict`): `reschedule_existing` (move conflicting event to alt slot + confirm new), `cancel_existing` (cancel conflicting + confirm new), `keep_both` (accept overlap + confirm new + complete action), `move_new` (move new meeting to different slot, stays as hold for user to confirm via UDĚLAT), `send_draft` (send the draft as-is)
- All resolution actions except `move_new` confirm the new event and complete the action. `move_new` creates a new hold — user still needs to click UDĚLAT.

**Design test case**: a W=100 personal event (doctor, kids' concert) against an nVal-max deal with a single possible time slot. An impossible situation. Mila surfaces the conflict, presents both sides, and the agent chooses. This is by design — Mila never resolves impossible conflicts silently.

### Calendar Invitations
- When Mila detects an invitation (from email/WhatsApp text or calendar event), she always creates a SCHEDULE action for user approval — human in the loop, no auto-accept
- Mila checks user's calendar and suggests accept/reject/propose new time

### Personal Calendar Events
- Personal events (matching `isPersonalEvent(title, settings)`) block time but do NOT generate action proposals
- Detection in calendar-ingestion.ts

## Mila Voice — Centralized Text Generation
**Module**: `src/lib/ai/mila-voice.ts` — single source of truth for ALL text Mila produces, both user-facing and CP-facing.

### Mila → User (uses settings.ai_tone_user)

| Function | Replaces | Purpose |
|----------|----------|---------|
| `generateSchedulingIntent()` | Hardcoded overwrites in planning.ts | Rewrites AI's intent_cs with scheduling details (slot, conflicts, location) baked in. Tone scales with urgency |
| `generateLeadFollowUpIntent()` | Hardcoded templates in lead-tracking.ts | Generates intent_cs + rationale_cs for cooling/cold/dead leads |
| `generateBriefIntro()` | Hardcoded greeting/subject in morning-brief.ts | Returns { greeting, subject, headline } for morning/afternoon briefs |
| `generateQuietBriefIntro()` | N/A (new) | Returns { greeting, subject, body } for quiet briefs (no pending actions). Receives today's events + todos for context |
| `generateUrgentIntro()` | Hardcoded urgent strings in morning-brief.ts | Returns { subject, header, body } for instant high-priority notifications |
| `generateBriefHeadline()` | N/A | Generates per-action-card headline + story for brief cards |
| `regenerateDraftWithInstruction()` | N/A | Rewrites draft based on user's free-text edit instruction |

### Mila → CP (uses settings.ai_tone_cp)

| Function | Replaces | Purpose |
|----------|----------|---------|
| `generateFinalDraft()` | Was in gemini.ts | CP-facing email/WhatsApp draft, on-demand at execution time |
| `generateConflictResolutionDraft()` | N/A | Generates reschedule/cancel notifications to counterparties when conflicts are resolved |

### Urgency-aware tone
Most user-facing functions receive urgency (directly or via action objects). `generateLeadFollowUpIntent()` derives urgency from lead status at the call site. The AI adjusts tone accordingly:
- **Urgency 9-10**: direct, bold, conveys time pressure
- **Urgency 4-8**: standard professional
- **Urgency 1-3**: calm, routine

### Tone settings (in UserSettings)
- `ai_tone_user` — how Mila talks TO the user (default: "professional and concise")
- `ai_tone_cp` — how Mila talks TO counterparties (default: "polite and formal")

Both injected into prompts via mila-voice.ts. When user-configurable tone UI lands, it plugs in here.

### Draft Generation
- **Timing**: On-demand only — drafts are generated at execution time, NOT during proposal creation.
- **Language**: Matches ai_language setting.
- **Channel-aware tone**: Implemented — email gets formal tone + signature; WhatsApp gets short, conversational messages.
- Proposal phase stores: intent_cs, rationale_cs, missing_info, dollar_value, offer_multiplier, weight. Draft fields (draft_subject, draft_body_text) are null until execution. Channel is stored in payload.channel. Deal context (deal_type, weight, is_high_value) is stored in payload.action_metadata.
- `generateFinalDraft()` in `src/lib/ai/mila-voice.ts` takes conversation context + intent + user notes + channel → returns { subject, body }.

## Bulk Ingestion & Backfill Report
Historical email backfill with 5-phase pipeline (fetch → enrich → thread → classify → report). Phases 1/2/4 run 5 emails in parallel to prevent Gemini API 429 errors, utilizing strict round-robin key rotation. Uses QStash worker chaining on Vercel, NDJSON streaming locally. See docs/BULK-INGESTION.md for full details including QStash architecture, batch sizes, and backfill action handler.

## WhatsApp Integration
Standalone Baileys daemon (`scripts/whatsapp-daemon.ts`) — pure WebSocket, multi-session, ~5-10 MB/session. Messages flow into agent pipeline same as email. See docs/WHATSAPP.md for daemon API, message flow, and scaling details.

- **Process Manager**: Runs via PM2 (`pm2 start scripts/whatsapp-daemon.ts --watch`) on an always-on server/PC. Note: `scripts/` is at the repo root, not under `src/`.
- **Companion Device**: Acts as a linked companion device. Works 24/7 even if the user's phone is turned off, out of battery, or in their pocket.
- **Group Chats**: Extracts the participant (sender) ID from group messages, prepends the group name to the text (e.g., `[Group: Prodej Praha] Jan: Ano`), and processes it so Mila understands multi-party deal chats.
- **Channel resolution**: Daemon creates/reuses a `channels` record (type='whatsapp', identifier=phone) per user via `getWhatsAppChannelId()`. The channel UUID is stored as `channel_id` on each message. Services use `getChannelType(channelId)` / `getChannelTypes(ids)` from `src/lib/db/channels.ts` to detect channel type. Email messages have `channel_id: null` (backward compat, resolves to 'email'). Future channels follow the same pattern: create a `channels` row, use its UUID.
- **Message extraction**: `extractMessageText()` handles all WhatsApp message types — plain text, media captions, templates, contacts, locations, voice messages, buttons, lists, polls, edited/view-once/ephemeral wrappers. Excludes only protocol messages, key distribution, reactions, and stickers.

## Self-Email Commands
User sends email to themselves with "Mila:" subject prefix → intercepted in ingestion pipeline → AI-parsed → executed. No new endpoints, no new UI — reuses existing email ingestion. See docs/COMMANDS.md for full details.

**Implementation**: `src/lib/commands/` (parser.ts, executor.ts)

**Supported commands (V1)**:
| Command | Aliases | AI Extracts | Executes |
|---------|---------|-------------|----------|
| new_contact | contact, kontakt, nový kontakt | name, email?, phone?, role?, company? | findOrCreateCP + updateCP |
| todo | task, úkol, ukol | description, dueDate? | createTodo |

**Integration point**: `src/services/ingestion.ts:212-246` — after self-email detection, before `return null`.

**Lifecycle**: Detection (`isMilaCommand`) → Classification (`classifyCommand`) → AI body parsing (`runAITask` 'classify') → DB execution → audit log (`writeAuditLog`) → message stored for dedup → result surfaced in next brief ("Zpracované příkazy" section).

**Reused functions**: `findOrCreateCP`, `upsertCP`, `updateCP` from db/counterparties.ts; `createTodo` from db/todos.ts; `normalizePhoneNumber` from whatsapp/types.ts; `runAITask` from ai/runner.ts; `writeAuditLog` from db/gdpr.ts.

## Conventions
- All server-side code uses async/await with Supabase client
- Error handling: check error from Supabase responses, throw with descriptive messages
- API routes use Next.js App Router conventions (route.ts with exported HTTP method functions)
- Components use Tailwind CSS classes (no CSS modules)
- Type imports use `import type { ... }` syntax
- Tests use Vitest — test files are co-located with source (*.test.ts). See Testing section below for sync rules
- **Import hierarchy**: `services/` → `shared/`, `lib/`, `config/`. Orchestrators (agent.ts, morning-brief.ts) import other services. Peer services (planning, lead-tracking, threading, etc.) do NOT import from each other. Shared pure functions live in `src/shared/`. If you need a function in two peer services, put it in `shared/`, not in one service and import from the other

## Testing
**Framework**: Vitest 4 with @/* path aliases. Tests co-located (foo.ts → foo.test.ts). Mock-Only-AI philosophy: mock AI + Google APIs, everything else (DB, scoring, tokens, cleaning) runs for real.

**~511 tests total**: across 32 test files including unit, integration (need DB), 10 smoke (opt-in), and 8 e2e (opt-in, 100% live). Full test inventory, tiers, and update rules: See docs/TESTING.md

**Key rules**:
- Changed a function → update its pinning test
- Changed a default → update defaults.test.ts + field count
- New API route → add auth test in route-protection.test.ts
- Run `npm test` before every commit. Tests must pass alongside `npm run build`.

## Security & Authentication

### Authentication Model
**Email Ownership via Google OAuth** — Users authenticate by connecting their Google account. Ownership of Gmail/Calendar proves identity.

### API Protection
All API endpoints are protected by one of:
- **API Key** (MILA_USER_API_KEY) — For /api/agent/run, /api/ingest, /api/ingest/bulk, /api/gdpr/*
- **Cron Secret** (CRON_SECRET) — For /api/cron/*, /api/agent/dispatch, /api/ingest/bulk/worker
- **Action Token** (HMAC-signed) — For /api/action/[id]/* (email links)
- **Superadmin Key** — For /api/superadmin/*

**Implementation**: `src/lib/auth/api.ts` exports `verifyApiKey(request)` middleware.

### Row Level Security (RLS)
- All Supabase tables have user_id column
- RLS policies ensure data isolation between customers
- API routes use service key (bypasses RLS) — MUST manually validate user_id

### Critical Environment Variables
```bash
MILA_USER_API_KEY    # Unique per deployment (API protection)
CRON_SECRET          # Protects cron endpoints
NEXTAUTH_SECRET      # Token signing secret
SUPABASE_SERVICE_KEY # Database admin access (NEVER expose)
GEMINI_API_KEYS      # Comma-separated Gemini keys for rotation (optional, falls back to GEMINI_API_KEY)
ANTHROPIC_API_KEY    # Claude fallback models (required for fallback chain)
QSTASH_TOKEN         # Upstash QStash token for brief scheduling + bulk ingest worker chaining
```

**SECURITY**: OAuth tokens migrating from `users.google_oauth_tokens` (plaintext jsonb) to `users.encrypted_google_tokens` (encrypted text). See SECURITY.md.

## AM/PM Briefs

### Scheduling via QStash (Upstash)
- Two daily briefs — AM (default 7:00) and PM (default 11:30), per-user configurable. AM prepares the agent before their main work block; PM covers what's still pending plus a preview of tomorrow.
- No Vercel cron — briefs are scheduled per-user via QStash (`src/lib/qstash/client.ts`)
- `createBriefSchedules(userId, morningTime, afternoonTime, timezone)` → creates QStash schedules that call `/api/cron/morning-brief?userId=<id>` at each user's configured times
- `updateBriefSchedules()` / `deleteBriefSchedules()` for lifecycle management
- Schedule IDs stored in user settings for cleanup
- Requires QSTASH_TOKEN env var
- The `/api/cron/morning-brief` endpoint still exists as the target for QStash HTTP calls

### Quiet Brief
When a user has zero pending action proposals, Mila sends a streamlined quiet brief instead of skipping the email:
- Triggered by `actions.length === 0` in `sendMorningBrief()`
- Fetches today's events (`getEventsForToday`), upcoming events (`getUpcomingEvents`, 3 days), todos (`getTodosDueToday` + `getOverdueTodos`)
- AI-generated greeting/subject/body via `generateQuietBriefIntro()` (drafting stage)
- Rendered by `generateQuietBriefEmailHtml()` — themed HTML with sections: "Dnešní program", "Nadcházející dny", "Úkoly"
- Fallback on AI failure: "Hezké ráno/odpoledne" + "Mila: Vše v pořádku"
- Limits: 5 upcoming events, 5 todos (overdue + today, deduplicated by ID)

### "Done" Section (Completed Actions)
Both normal and quiet briefs show what Mila already handled:
- `getRecentlyCompletedActions(userId, since)` fetches actions completed/approved in the last 24 hours
- Each item enriched with CP name, topic, action type, intent
- Normal brief: rendered as a "Co už Mila vyřídila" section below action cards (green left border)
- Quiet brief: completed items enriched above the quiet/normal fork so both paths share the data

### Action Ordering in Briefs
Actions are grouped by conversation and ordered for the agent's workflow:
1. **Conversations sorted by highest urgency** — most urgent conversation first, then by priority_score
2. **Within a conversation, logical dependency order** — TODO (prep work) before REPLY/SCHEDULE (CP-facing action)
3. **TODO suppresses CP action** — if a conversation has both a TODO (fact-gathering, document prep) and a REPLY/SCHEDULE, only the TODO appears in the brief. The CP action surfaces in a later brief after the TODO is marked done. Exception: if ALL actions in the conversation are urgent (>= 9), show everything.

This prevents the brief from asking the user to send a reply they can't write yet (e.g., "confirm financing" before the user has checked with the bank).

### Parallelized Sending
- `sendAllMorningBriefs()` processes users in batches of 10 (BRIEF_CONCURRENCY)
- Uses `Promise.allSettled()` for fault isolation — one user's failure doesn't block others
- 5-minute function timeout (maxDuration: 300) handles ~100 users per invocation

### Instant High-Priority Notifications
Actions with urgency >= 9 get an immediate email notification (same action card template as briefs).

- **Polling**: Global QStash schedule (`*/5 * * * *`) hits `/api/cron/instant-notify` every 5 minutes
- **Query**: `getHighPriorityUnnotifiedActions(urgencyThreshold)` — finds urgency >= threshold, status = 'pending', last_notified_at IS NULL, queued_for_brief = true
- **Grouping**: One email per **conversation** — multiple urgent actions from the same conversation go in one email. Different conversations → separate emails. Never merges across conversations.
- **Schedule optimizer**: Uses `scheduleSingleAction()` per urgent SCHEDULE action (NOT the batch `optimizeScheduleActions()` used by briefs). Re-fetches actions after scheduling so hold data is reflected in cards.
- **Send**: `sendInstantNotifications()` groups actions by conversation, sends one email per conversation, batches at concurrency 10
- **Re-inclusion in brief**: `markActionsInstantNotified()` sets last_notified_at but keeps queued_for_brief = true — if the user doesn't act, the action still appears in the next AM/PM brief
- **No double-send**: last_notified_at IS NULL filter prevents re-sending on subsequent polls
- **Schedule management**: `createInstantNotifySchedule()` / `deleteInstantNotifySchedule()` in `src/lib/qstash/client.ts`
- **Threshold**: DEFAULT_INSTANT_URGENCY_THRESHOLD = 9 in morning-brief.ts

## Error Monitoring (Sentry)
- **Client-side**: Session replay + error tracking
- **Server-side**: API route errors, database issues
- **Edge runtime**: Middleware errors
- **Config**: instrumentation.ts, instrumentation-client.ts (exist at both repo root and src/), sentry.server.config.ts, sentry.edge.config.ts
- **Global handler**: `src/app/global-error.tsx` (React error boundary)
- **Setup**: Requires SENTRY_DSN env var. Free tier = 5k errors/month.

## Documentation Files
- **SPEC.md** — Full product specification
- **CLAUDE.md** (this file) — Code architecture reference for AI coding assistants
- **SECURITY.md** — Security architecture, risks, incident response
- **ONBOARDING.md** — User setup, settings reference, API quick reference
- **docs/SCHEMA.md** — Database schema, deal property model, migration SQL
- **docs/TESTING.md** — Test tiers, inventory, update rules, setup
- **docs/BULK-INGESTION.md** — Bulk ingestion pipeline, QStash worker chaining, backfill report
- **docs/WHATSAPP.md** — WhatsApp daemon API, message flow, scaling
- **docs/COMMANDS.md** — Self-email command interface, supported commands, architecture
- **docs/DEAL-TIMELINE-SPEC.md** — Unified Deal Timeline technical specification, migration SQL, conversation assignment algorithm, CP role tiers
- **docs/DISPATCHER-SPEC.md** — Agent dispatcher architecture, Gmail history.list polling, QStash fan-out, scaling to 5000+ users
- **docs/COST-ESTIMATE.md** — Per-user monthly cost breakdown, AI model assignments, scaling scenarios, cost reduction levers

## GDPR Compliance
**Implementation**: `src/lib/db/gdpr.ts` — deleteAllUserData (FK-safe cascade across 14 tables), exportAllUserData, writeAuditLog (never throws), enforceRetentionPolicy.

- `POST /api/gdpr/delete` — Art. 17 Right to Erasure. Auth: API key.
- `GET /api/gdpr/export?userId=` — Art. 15 Right of Access. Auth: API key.
- **Soft Deletion**: Implements a deleted_at timestamp for the users table. Wipes personal/business data but keeps the UUID intact so audit_logs are not orphaned.

## Concurrency Control
**DB-level agent lock** (`src/lib/db/locks.ts`) — tryAcquireUserLock/releaseUserLock with 10-min auto-expiry. Strictly relies on DB lock. Aborts if DB lock fails (no in-memory fallback). Used in `agent.ts` → `runAgentForUser()`.

Migration SQL for locks, audit logs, and enriched_text: See docs/SCHEMA.md.

## Parallelism Architecture
All services use batched Promise.allSettled for fault isolation — one item's failure doesn't block others.

| Service | Pattern | Concurrency | Notes |
|---------|---------|-------------|-------|
| dispatch/route.ts | Gmail history.list per user, QStash fan-out | 100 (check), 1/sec (publish) | Pages at 1000 users; staggered agent run delivery |
| agent.ts | Steps 2/2.1/2.5 in parallel | 3 | Inbound, outbound, calendar are independent |
| planning.ts | Conversations batched | 5 | Each involves AI calls (triageConversation + verifyTriage per conversation) |
| ingestion.ts | Emails batched (inbound + outbound) | 5 | classifyEmail AI call is the bottleneck |
| lead-tracking.ts | Conversations batched | 10 | Independent conversations, DB-heavy |
| threading.ts | Pre-assigned lookups + CP fetches | All | Promise.all for reads; serial for assignToConversation (prevents duplicate creation) |
| bulk-ingestion.ts | QStash worker chaining (Vercel) + batched allSettled | 5 parallel / 50 per QStash hop | Phase 1 splits into 50-email hops via QStash; Phases 2–5 each a single hop. Phases 1/2/4 process 5 emails in parallel within each hop to prevent 429 errors |

## Superadmin
- Dashboard at `/superadmin`
- Protected by SUPERADMIN_KEY env var (passed via ?key= or header)
- Shows system health, user stats, and error logs
