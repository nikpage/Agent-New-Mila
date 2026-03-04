# CLAUDE.md — Project Guide for Claude Code

## RULES
- NEVER take action (edit files, write code, run commands) without explicit user instruction
- When reporting problems: ONLY list what's wrong and wait
- Ask "Want me to fix this?" and WAIT for "yes"
- Default mode is RESEARCH AND REPORT, not act
- NEVER default to generic patterns. Every decision must be specific to THIS project (Mila, nikpage/Agent-New-Mila, shared multi-tenant deployment)
- NEVER use placeholders, stubs, or "TODO" on the developer side. Use real values, real logic, real implementations
- NEVER take shortcuts that create maintenance debt (e.g., clone-per-client instead of multi-tenant, hardcoded config instead of DB-driven)
- NEVER modify expected values in pinning tests (files: `actions.test.ts`, `lead-tracking.test.ts`, `threading.test.ts`, `defaults.test.ts`). If a pinning test fails, REPORT the failure and WAIT. Do not update the test to match new output

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
**Mila** is an AI-powered executive assistant that ingests emails, WhatsApp messages, and calendar events, uses Gemini AI to propose actions (reply, schedule, follow up, delegate), tracks leads, and presents everything for user approval via morning brief emails.

- **Stack**: Next.js 14 (App Router) / TypeScript 5.7 (strict) / Supabase / Tailwind CSS 3
- **AI**: Google Gemini (primary) via `@google/generative-ai` + Anthropic Claude (fallback) via `@anthropic-ai/sdk`
- **Deployment**: Vercel (briefs scheduled via Upstash QStash)
- **Monitoring**: Sentry error tracking (client + server + edge)
- **Path alias**: `@/*` → `src/*`
- **Full product spec**: See `SPEC.md`

## Commands
```bash
npm run build        # Production build (the primary check — catches type errors + lint)
npm test             # Run Vitest test suite (296 tests: 252 unit, 22 integration, 10 smoke, 12 e2e)
npm run typecheck    # TypeScript only: tsc --noEmit
npm run lint         # ESLint via next lint
npm run dev          # Dev server (uses 8GB heap)
npm run test:watch   # Vitest in watch mode (re-runs on file change)
npm run test:coverage # Vitest with v8 coverage report
```
**After making changes, run `npm test && npm run build`** to verify nothing is broken.

## Architecture Map

```
src/
├── app/                        # Next.js App Router (pages + API routes)
│   ├── api/agent/run/          # Main agent orchestration endpoint
│   ├── api/action/[id]/        # Action CRUD + execute/draft/todo/blacklist
│   ├── api/auth/               # OAuth connect + callback
│   ├── api/cron/morning-brief/ # Brief endpoint (called by QStash per-user schedules)
│   ├── api/gdpr/delete/        # GDPR Art. 17 — cascade-delete all user data
│   ├── api/gdpr/export/        # GDPR Art. 15 — export all user data as JSON
│   ├── api/ingest/             # Manual email/calendar ingestion
│   ├── api/ingest/bulk/        # Bulk historical ingestion orchestrator (QStash on Vercel, NDJSON locally)
│   ├── api/ingest/bulk/worker/ # QStash worker — processes Phase 1–4 in chained batches of 50
│   ├── api/backfill/action/    # Backfill report action handler (allow/blacklist/add/setrole)
│   ├── api/health/             # Health check
│   ├── api/whatsapp/status/    # WhatsApp daemon status proxy
│   ├── action/[id]/            # Action detail + edit pages
│   └── page.tsx                # Home/status dashboard
│
├── services/                   # Business logic (orchestration layer)
│   ├── agent.ts                # Main pipeline — 6-step orchestration (parallel ingestion)
│   ├── scheduling.ts           # Calendar slot finding (702 lines) ⚠️ LARGEST
│   ├── planning.ts             # Action generation with channel detection (parallel batches of 5)
│   ├── threading.ts            # Email/WA conversation grouping (enriched embeddings + external thread ID)
│   ├── ingestion.ts            # Email ingestion (parallel batches of 5)
│   ├── bulk-ingestion.ts       # Historical backfill — 5-phase: fetch → enrich → thread → classify → report
│   ├── backfill-report.ts      # "Welcome to Mila" report email after bulk ingestion (772 lines)
│   ├── calendar-ingestion.ts   # Calendar sync + personal event filtering
│   ├── lead-tracking.ts        # Cooling/cold/dead lead detection (parallel batches of 10)
│   └── morning-brief.ts        # Daily summary email (254 lines)
│
├── lib/                        # Shared utilities & integrations
│   ├── db/                     # Supabase CRUD — 11 files, ~2500 lines total
│   ├── google/                 # Google APIs — calendar, gmail, auth, maps
│   ├── supabase/               # Client + types (types.ts = 804 lines)
│   ├── ai/
│   │   ├── gemini.ts           # AI functions (preFilter, classify, enrichMessage, proposeAction, generateFinalDraft, etc.)
│   │   ├── runner.ts           # runAITask() with 3-model fallback + 429 retry
│   │   └── providers/          # gemini.ts (multi-key rotation), anthropic.ts, types.ts, index.ts
│   ├── qstash/
│   │   └── client.ts           # QStash per-user brief scheduling (morning + afternoon)
│   ├── whatsapp/
│   │   ├── types.ts            # WAIncomingMessage, WASendRequest, normalizePhoneNumber, etc.
│   │   ├── sender.ts           # sendWhatsAppMessage(), getWhatsAppStatus() — talks to daemon
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
│   ├── action/ActionCard.tsx   # Main action UI (382 lines)
│   ├── action/EditForm.tsx     # Action editor (142 lines)
│   ├── action/SuccessOverlay.tsx # Post-action success animation (103 lines)
│   ├── action/action-card-template.ts # HTML template for action card emails (140 lines)
│   └── ui/                     # Button, Card, Badge, Input
│
├── config/
│   ├── client.ts               # Per-client config (identity, business, AI persona, leads, WA, calendar, scoring)
│   ├── ai-models.ts            # 7 AI stages × 2-model fallback chains
│   └── theme.ts                # Design tokens
│
└── scripts/
    └── whatsapp-daemon.ts      # Standalone Baileys multi-session WA daemon (excluded from tsconfig)
```

## Agent Pipeline (src/services/agent.ts)

```
Step 1: Verify user exists + has Google credentials (early return if fail)
Step 0: purgeUserAsCp — data hygiene (runs after user is verified)
Steps 2 + 2.1 + 2.5 run IN PARALLEL (Promise.allSettled):
  Step 2: Ingest inbound emails from Gmail (clean → enrich → embed enriched text)
  Step 2.1: Ingest outbound emails from Gmail (clean → enrich → embed enriched text)
  Step 2.5: Sync Google Calendar events, detect invitations, filter personal events
Step 3: Get all unprocessed messages (email + WhatsApp)
Step 4: Thread messages into conversations (uses enriched_text for embedding similarity)
Step 5: Generate action proposals for updated conversations (channel-aware, adaptive context, batched ×5)
Step 6: Lead tracking — scan all conversations for cooling/cold/dead leads (batched ×10)
```

Result type includes: `emailsIngested`, `whatsappMessagesProcessed`, `calendarEventsSynced`, `calendarInvitationsDetected`, `messagesProcessed`, `conversationsUpdated`, `actionsGenerated`, `followUpsGenerated`, `coolingLeads`, `coldLeads`.

## Performance Rules (CRITICAL)

### Do NOT bulk-read directories
Never read all files in a directory sequentially. This bloats context and causes hangs.

**Worst offenders (do NOT read all files in these):**
- `src/lib/db/` — 11 files, ~2500 lines. Use the index below to pick the right file.
- `src/services/` — 11 files, ~4500 lines. Read only the service relevant to the task.
- `src/lib/google/` — 5 files, ~1400 lines. Read only the API you need.

### Do NOT follow imports into large type files
- `src/lib/supabase/types.ts` (804 lines) — Only read if you need specific type definitions. Use Grep to find the type you need instead.

### Strategy for understanding code
1. **Start with Grep** to find the function/type you need
2. **Read only the specific file** containing it
3. **Never read more than 2-3 files** from the same directory in one session
4. If you need broader context, use the Explore agent — it manages its own context

## src/lib/db/ Quick Reference
Instead of reading these files, use this index:

| File | Contents |
|------|----------|
| `users.ts` | `getUserById`, `getUserByEmail`, `upsertUser`, `getUserSettings`, `updateUserSettings`, `getUsersWithEmailEnabled`, `getUsersDueBrief`, `updateUserGoogleTokens`, `getUserGoogleTokens` |
| `counterparties.ts` | `normalizeGmailAddress`, `isSameGmailAddress`, `purgeUserAsCp`, `getCPById`, `getCPByIdentifier`, `getCPsForUser`, `upsertCP`, `findOrCreateCP`, `updateCP`, `blacklistCP`, `getCPState`, `updateCPState` |
| `conversations.ts` | `getConversationById`, `getConversationsForUser`, `createConversation`, `updateConversation`, `updateConversationSummary`, `incrementMessageCount`, `getMessagesForConversation`, `getRecentMessages`, `addParticipant`, `getParticipants`, `findConversationByExternalThread` |
| `messages.ts` | `getMessageById`, `getMessageByExternalId`, `messageExists`, `createMessage`, `createMessages`, `updateMessage`, `getMessagesInRange`, `getUnprocessedMessages`, `assignMessageToConversation`, `getLatestMessageFromCP`, `countMessagesInConversation` |
| `actions.ts` | `getActionById`, `getActionsForUser`, `getPendingActionsForBrief`, `createAction`, `updateAction`, `updateActionStatus`, `approveAction`, `completeAction`, `dismissAction`, `dismissAllPendingActions`, `updateActionDraft`, `markActionsNotified`, `getHighPriorityUnnotifiedActions`, `markActionsInstantNotified`, `calculatePriorityScore`, `getActionsForConversation`, `hasPendingAction` |
| `todos.ts` | `getTodoById`, `getTodosForUser`, `getPendingTodos`, `createTodo`, `updateTodo`, `completeTodo`, `deleteTodo`, `getTodosForThread`, `getOverdueTodos`, `getTodosDueToday` |
| `events.ts` | `getEventById`, `getEventsInRange`, `getEventsForToday`, `getUpcomingEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `findConflicts`, `getLastEventLocation`, `getEventsWithCP`, `findAvailableSlots`, `getEventsByBlockGroup`, `cleanupBlockGroup`, `createHoldEvent`, `createTravelBuffer`, `cleanupTravelBuffers`, `getTravelBuffers`, `confirmEvent`, `cancelEventWithCleanup`, `calculateEventScore`, `upsertEventByGoogleId`, `getChildEvents` |
| `embeddings.ts` | `saveMessageEmbedding`, `saveConversationEmbedding`, `getConversationsWithEmbeddingsByCP` |
| `gdpr.ts` | `writeAuditLog`, `exportAllUserData`, `deleteAllUserData`, `enforceRetentionPolicy` |
| `locks.ts` | `tryAcquireUserLock`, `releaseUserLock` |
| `index.ts` | Barrel re-exports (do not read) |

All db files follow the same pattern: import `getSupabaseAdmin` from `../supabase/client`, import types from `../supabase/types`, export async CRUD functions.

**SECURITY:** When adding new queries, always filter by `user_id` unless specifically needed:
```typescript
// GOOD
const actions = await supabase.from('action_proposals').select('*').eq('user_id', userId)

// BAD (exposes all users' data)
const actions = await supabase.from('action_proposals').select('*')
```

## Per-User Config

All user configuration is stored in `users.settings` JSONB column. See `ONBOARDING.md` for the full settings reference. Configured via `scripts/configure-user.ts`.

**`src/config/client.ts`** exports helper functions that take `UserSettings` as input:
- `getAISystemPrompt(settings)` — builds the AI system prompt from user's business context
- `containsHighValueSignals(text, settings)` — checks text against user's high-value keywords (used in both planning and lead tracking)
- `isPersonalEvent(title, settings)` — detects personal calendar events

The `clientConfig` const object in this file is **legacy dead code** — not consumed at runtime. All runtime behavior reads from `UserSettings` via DB.

## Lead Tracking (src/services/lead-tracking.ts)

Runs as Step 6 of agent pipeline. Scans all conversations, detects stale leads:

| Status | Days Inactive | Action |
|--------|--------------|--------|
| Active | < 2 | None |
| Cooling | 2-5 | Gentle check-in (1.5x priority boost) |
| Cold | 5-14 | Urgent follow-up (2.5x boost) |
| Dead | 14+ | Last-chance contact (3.75x boost) |

Skips conversations with existing pending actions. Caps at 3 auto follow-ups per conversation. Uses `selectOfferMultiplier()` to apply seller/buyer role-based multiplier to follow-up priority scores. High-value conversations (matching `highValueSignals`) get additional 1.5x boost in lead tracking and are flagged to the AI during planning for better dollar value estimation.

## Database Schema

Full schema reference (all tables, columns, deal property model, migrations): See `docs/SCHEMA.md`

Key tables: `users`, `cps`, `conversation_threads`, `messages`, `action_proposals`, `events`, `todos`, `emails`, `audit_logs`, `user_agent_locks`. All tables have `user_id` — always filter by it in queries.

## Priority Scoring

**Formula:** `score = normVal + U + daysIgnored² + W`

Four independent terms — each measures a different dimension, no cross-contamination:
1. `normVal = log_compress(dollarValue) × sellerMultiplier` — deal size (post-log multiplier so it's a real % boost)
2. `U` — urgency: AI-assessed starting pressure (1-10). Also the baseline for non-deal tasks (doctor appointment, printer deadline)
3. `daysIgnored²` — time pressure that escalates quadratically. Day 0 = 0, day 1 = 1, day 3 = 9, day 7 = 49
4. `W` — weight/immovability: flat, never changes. 1-10 for normal items, 100 for absolutely immovable (court date, kids concert)

**Why these are independent:**
- **normVal** answers "how much money is at stake?" — static for the deal's lifetime
- **U** answers "how urgently does this need doing?" — sets both the starting floor and baseline pressure
- **daysIgnored²** answers "how long has this been sitting?" — escalates equally regardless of deal value
- **W** answers "can this be moved?" — kid's concert is W=100 from day 1 to day 1000, never changes

**Why log normalization exists:** Different users have different deal ranges. Agent A sells 2M-5M homes, Agent B sells 10M-100M. The log scale maps both to the same score range (~2-13 for their respective kcLow→kcHigh). Like Fibonacci tiers (1,2,3,5,8,13,21,34) but smooth — no jumps between values. User sets their own anchors via `kc_low_value` and `kc_high_value`. Below-floor deals go below 2 (can be negative) — they sink naturally.

**Why sellerMultiplier is post-log:** Applied AFTER log compression so 1.5× actually gives 50% more score. Pre-log it gets swallowed by the logarithm and barely moves the needle. Default 1.5 for sellers, 1.0 for buyers (user-configurable).

**Implementation:** `src/lib/db/actions.ts` → `calculatePriorityScore()`

| Input | Scale | Notes |
|-------|-------|-------|
| `dollarValue` | 0+ (CZK) | Deal/transaction value |
| `kcLowValue` | default 500000 | "Small deal" anchor from `settings.kc_low_value`. Maps to normalized score ~2. |
| `kcHighValue` | default 5000000 | "Big deal" anchor from `settings.kc_high_value`. Maps to normalized score ~13. |
| `sellerMultiplier` | default 1 | Applied AFTER log. From user settings: `offer_multiplier_seller` (1.5) or `offer_multiplier_buyer` (1.0) based on CP role |
| `urgency` | 1-10 | AI-assessed, safe default 1 |
| `daysIgnored` | 0+ | Days since last activity (squared: day 3 = 9, day 7 = 49) |
| `weight` | 1-10 or 100 | How movable: 1 = easy to reschedule, 10 = hard to move. 100 = absolutely immovable (court date, kids concert, airport pickup). No values between 10-100. |

Safe defaults: `urgency`, `sellerMultiplier` fallback to 1 if 0/null (prevents score collapse). `kcLowValue` falls back to 500000, `kcHighValue` must be > kcLowValue (falls back to kcLowValue × 10).

**DO NOT REMOVE OR CHANGE** the log-scale normalization, the four-term independence, or `weight` wiring without explicit user permission.

**Wiring:** `planning.ts` passes `sellerMultiplier` (from CP role via `selectOfferMultiplier`), `kcLowValue`/`kcHighValue` (from user settings), and `weight` (from AI response) to `calculatePriorityScore()`. `lead-tracking.ts` also passes `sellerMultiplier` and `kcLowValue`/`kcHighValue` for follow-up actions.

## AI Model Configuration

**Config:** `src/config/ai-models.ts` — 7 pipeline stages, each with 2-model fallback chain (3rd slot reserved but unused).
**Runner:** `src/lib/ai/runner.ts` → `runAITask(stage, prompt)` — auto-cascades on failure, retries 429s with exponential backoff (1s, 2s, 4s), logs which model succeeded.

| Stage | Purpose | Primary → Fallback1 → Fallback2 |
|-------|---------|----------------------------------|
| `filter` | Spam detection | `gemini-2.5-flash-lite` → `claude-haiku-4-5-20251001` |
| `classify` | Email category + priority | `gemini-2.5-flash-lite` → `claude-haiku-4-5-20251001` |
| `enrichment` | Per-message key info extraction | `gemini-2.5-flash-lite` → `gemini-2.5-flash` |
| `threading` | extractTopic, shouldJoinConversation | `gemini-2.5-flash` → `claude-sonnet-4-6` |
| `analysis` | analyzeConversation | `gemini-2.5-flash` → `claude-sonnet-4-6` |
| `planning` | proposeAction (type, rationale, intent) | `gemini-2.5-flash` → `claude-sonnet-4-6` |
| `drafting` | generateFinalDraft, generateBriefHeadline | `gemini-2.5-flash` → `claude-sonnet-4-6` |

**Rate limit handling:** On 429/RESOURCE_EXHAUSTED errors, retries same model up to 3 times with exponential backoff before falling to next model in chain.

**Embedding model:** `gemini-embedding-001` (768-dim, multilingual) — separate from chat, NO fallback chain. Embedding failures are caught silently — the app works without them (threading falls back to Gmail thread ID matching).

**Providers:**
- `src/lib/ai/providers/gemini.ts` — `@google/generative-ai` SDK. Supports **multi-key rotation** via `GEMINI_API_KEYS` (comma-separated) — round-robins across keys. Falls back to single `GEMINI_API_KEY` if not set.
- `src/lib/ai/providers/anthropic.ts` — `@anthropic-ai/sdk`. Uses `ANTHROPIC_API_KEY` env var.

**Prompt language convention: ALL prompts are written in English. Czech output is requested via explicit directives (e.g. "in Czech", "Output in CZECH").** This is consistent across all 9 AI functions. Never write mixed-language prompts — English instructions with Czech labels, or vice versa. If the AI needs to output Czech, tell it in English.

**Business context injection:** `getAISystemPrompt()` from `src/config/client.ts` is prepended to `proposeAction()`, `generateFinalDraft()`, and `analyzeConversation()` prompts. `enrichMessage()` receives a lighter business context (company, specialization, market) + language setting. All AI functions that process user content now receive `UserSettings` for consistent language (Czech) and domain interpretation. Channel context (email vs WhatsApp) adjusts tone. High-value signal detection (`containsHighValueSignals`) flags conversations in the `proposeAction` prompt. AI estimates `dollarValue` and `weight` (0-100 immovability) in the user's configured currency with typical deal range as reference, and classifies `dealType`.

## Embeddings & Semantic Threading

**Purpose:** Assign incoming messages to existing conversations when external thread ID doesn't match. Supports cross-channel matching (WhatsApp message finds its email conversation).

**Per-message enrichment** (`enrichMessage` in `gemini.ts`):
- Runs after cleaning, before threading. Extracts: who's involved, property/subject, message kind, deal numbers, core intent.
- **Output language:** Czech (matches `ai_language` setting). Enrichment prompt includes business context from `UserSettings` so domain-specific terms are interpreted correctly (e.g. Czech "statek" = farm/estate, not "ship").
- Saves to `messages.enriched_text` column. Embedding generated from enriched text (not raw body).
- Stage: `enrichment` (gemini-2.5-flash-lite → gemini-2.5-flash). Cost-sensitive — runs per message.
- Accepts optional `UserSettings` for business context injection. All callers (`ingestion.ts`, `bulk-ingestion.ts`, QStash worker) fetch and pass user settings.
- Runs in **both** regular ingestion (`ingestion.ts`) **and** bulk historical ingestion (`bulk-ingestion.ts`). Bulk enrichment runs in Phase 2 (`Phase2EnrichResult` tracks `enriched`, `enrichmentFailed`, `embedded`, `embeddingFailed`).

**Pipeline** (`src/services/threading.ts`):
1. **External thread ID match** (primary) — exact match on `external_thread_id` (Gmail thread ID, Exchange conversation ID, `wa:+phone`). Only matches messages already assigned to a conversation (`conversation_id IS NOT NULL`) — unassigned messages are skipped to prevent 1:1 message-to-conversation creation during bulk ingestion.
2. **Enriched embedding similarity** (secondary) — cosine similarity of enriched message embedding against conversation embeddings, same CP only
3. **New conversation** (fallback) — if nothing matches. Creates thin-conversation ToDo if enrichment yielded < 100 chars.

**Thresholds:**
- `≥ 0.78` → auto-join conversation (no AI needed)
- `0.55 – 0.78` → AI tiebreak via `shouldJoinConversation()`
- `< 0.55` → new conversation

**WhatsApp threading:** By phone number — `external_thread_id = wa:+phone`

**Conversation summaries** (`analyzeConversation` in `gemini.ts`) use enriched messages (adaptive count: enough to reach ~1500 chars). Falls back to cleaned_text for older un-enriched messages. Embedding generated from summary text. Accepts optional `UserSettings` — when provided, the AI receives business context and explicit role mapping: `[outbound]` = user (email account owner), `[inbound]` = counterparty. All output in Czech.

**Channel-aware cleaning** (`cleanMessageText` in `generate.ts`):
- `email`/`email/gmail`: Full cleaning (signatures, quoted replies, disclaimers, tracking pixels)
- `email/exchange`: Gmail base + Outlook-specific patterns (EXTERNAL EMAIL banners, From/Sent/To headers, aka.ms links)
- `whatsapp`: Minimal — system messages and forwarded labels only
- `cleanEmailText()` is a backward-compatible alias for `cleanMessageText(text, 'email')`

## Scheduling & Conflict Resolution

**Implementation:** `src/services/scheduling.ts` (702 lines — largest service)

### Slot Finding
- `findFreeSlots()` scans working hours for gaps between ALL calendar events
- Respects `working_hours_start/end`, `working_days` from user settings
- Applies `meeting_buffer_minutes` (default 15m) between meetings

### Travel Time
- `calculateTravelForSlot()` uses Google Maps Distance Matrix API (`src/lib/google/maps.ts`)
- Origin: previous event location → office_location → home_location (fallback chain)
- Buffer = `max(travelTime + 10min, 15min minimum)`
- Creates travel buffer events linked via `parent_event_id`
- Travel mode from user settings: driving/walking/transit/bicycling

### Priority-Based Conflict Resolution
When a new meeting conflicts with existing events:
- `handleConflict()` compares `calculateEventScore()` of new vs existing
- **New score > existing score** → `recommendation: 'move_existing'`
- **New score ≤ existing score** → `recommendation: 'suggest_alternate'`
- **User-created events default weight = 100** (treated as immovable)

### Personal Calendar Events
- Personal events (matching keywords in `src/config/client.ts` → `calendar.personalEventKeywords`) **block time** but **do NOT generate action proposals**
- Detection via `isPersonalEvent(title)` in `calendar-ingestion.ts`

## Draft Generation

**Timing:** On-demand only — drafts are generated at execution time, NOT during proposal creation.
**Language:** Czech (configured in `src/config/client.ts` → `ai.language`)
**Channel-aware tone:** Implemented — email gets formal tone + signature; WhatsApp gets short, conversational messages.

Proposal phase stores: `intent_cs`, `rationale_cs`, `missing_info`, `dollar_value`, `offer_multiplier`, `weight`. Draft fields (`draft_subject`, `draft_body_text`) are null until execution. Channel is stored in `payload.channel`. Deal context (`deal_type`, `weight`, `is_high_value`) is stored in `payload.action_metadata`. Note: `pain_factor` column exists in DB but is no longer used — removed from formula.

`generateFinalDraft()` in `src/lib/ai/gemini.ts` takes conversation context + intent + user notes + channel → returns `{ subject, body }`.

## Bulk Ingestion & Backfill Report

Historical email backfill with 5-phase pipeline (fetch → enrich → thread → classify → report). Phases 1/2/4 run 20 emails in parallel. Uses QStash worker chaining on Vercel, NDJSON streaming locally. See `docs/BULK-INGESTION.md` for full details including QStash architecture, batch sizes, and backfill action handler.

## WhatsApp Integration

Standalone Baileys daemon (`scripts/whatsapp-daemon.ts`, port 3001) — pure WebSocket, multi-session, ~5-10 MB/session. Messages flow into agent pipeline same as email. See `docs/WHATSAPP.md` for daemon API, message flow, and scaling details.

## Conventions
- All server-side code uses `async/await` with Supabase client
- Error handling: check `error` from Supabase responses, throw with descriptive messages
- API routes use Next.js App Router conventions (`route.ts` with exported HTTP method functions)
- Components use Tailwind CSS classes (no CSS modules)
- Type imports use `import type { ... }` syntax
- Tests use Vitest — test files are co-located with source (`*.test.ts`). See **Testing** section below for sync rules

## Testing

**Framework:** Vitest 4 with `@/*` path aliases. Tests co-located (`foo.ts` → `foo.test.ts`). Mock-Only-AI philosophy: mock AI + Google APIs, everything else (DB, scoring, tokens, cleaning) runs for real.

**296 tests total:** 252 unit + 22 integration (need DB) + 10 smoke (opt-in) + 12 e2e (opt-in, 100% live). Full test inventory, tiers, and update rules: See `docs/TESTING.md`

**Key rules:**
- Changed a function → update its pinning test
- Changed a default → update `defaults.test.ts` + field count
- New API route → add auth test in `route-protection.test.ts`
- Run `npm test` before every commit. Tests must pass alongside `npm run build`.

## Security & Authentication

### Authentication Model
**Email Ownership via Google OAuth** — Users authenticate by connecting their Google account. Ownership of Gmail/Calendar proves identity.

### API Protection
All API endpoints are protected by one of:
1. **API Key** (`MILA_USER_API_KEY`) — For `/api/agent/run`, `/api/ingest`, `/api/ingest/bulk`, `/api/gdpr/*`
2. **Cron Secret** (`CRON_SECRET`) — For `/api/cron/*`, `/api/ingest/bulk/worker`
3. **Action Token** (HMAC-signed) — For `/api/action/[id]/*` (email links)
4. **Superadmin Key** — For `/api/superadmin/*`

**Implementation:** `src/lib/auth/api.ts` exports `verifyApiKey(request)` middleware.

### Row Level Security (RLS)
- All Supabase tables have `user_id` column
- RLS policies ensure data isolation between customers
- API routes use service key (bypasses RLS) — MUST manually validate `user_id`

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

**SECURITY:** OAuth tokens migrating from `users.google_oauth_tokens` (plaintext jsonb) to `users.encrypted_google_tokens` (encrypted text). See `SECURITY.md`.

## Morning/Afternoon Briefs

### Scheduling via QStash (Upstash)
- **No Vercel cron** — briefs are scheduled per-user via QStash (`src/lib/qstash/client.ts`)
- `createBriefSchedules(userId, morningTime, afternoonTime, timezone)` → creates QStash schedules that call `/api/cron/morning-brief?userId=<id>` at each user's configured times
- `updateBriefSchedules()` / `deleteBriefSchedules()` for lifecycle management
- Schedule IDs stored in user settings for cleanup
- Requires `QSTASH_TOKEN` env var
- The `/api/cron/morning-brief` endpoint still exists as the target for QStash HTTP calls

### Parallelized Sending
- `sendAllMorningBriefs()` processes users in batches of 10 (`BRIEF_CONCURRENCY`)
- Uses `Promise.allSettled()` for fault isolation — one user's failure doesn't block others
- 5-minute function timeout (`maxDuration: 300`) handles ~100 users per invocation

### Instant High-Priority Notifications
Actions with `priority_score > 79` get an immediate email notification (same action card template as briefs).

- **Polling:** Global QStash schedule (`*/5 * * * *`) hits `/api/cron/instant-notify` every 5 minutes
- **Query:** `getHighPriorityUnnotifiedActions(threshold)` — finds `priority_score > threshold`, `status = 'pending'`, `last_notified_at IS NULL`, `queued_for_brief = true`
- **Send:** `sendInstantNotifications()` groups actions by user, sends email with `⚡ Urgentní akce` subject, batches users at concurrency 10
- **Re-inclusion in brief:** `markActionsInstantNotified()` sets `last_notified_at` but keeps `queued_for_brief = true` — if the user doesn't act, the action still appears in the next morning/afternoon brief
- **No double-send:** `last_notified_at IS NULL` filter prevents re-sending on subsequent polls
- **Schedule management:** `createInstantNotifySchedule()` / `deleteInstantNotifySchedule()` in `src/lib/qstash/client.ts`
- **Threshold:** Default 79, passed as parameter to `sendInstantNotifications()`


## Error Monitoring (Sentry)
- **Client-side:** Session replay + error tracking
- **Server-side:** API route errors, database issues
- **Edge runtime:** Middleware errors
- **Config:** `instrumentation.ts`, `instrumentation-client.ts`, `sentry.*.config.ts`
- **Global handler:** `src/app/global-error.tsx` (React error boundary)

**Setup:** Requires `SENTRY_DSN` env var. Free tier = 5k errors/month.

## Documentation Files
- **`SPEC.md`** — Full product specification
- **`CLAUDE.md`** (this file) — Code architecture reference for AI coding assistants
- **`SECURITY.md`** — Security architecture, risks, incident response
- **`ONBOARDING.md`** — User setup, settings reference, API quick reference
- **`docs/SCHEMA.md`** — Database schema, deal property model, migration SQL
- **`docs/TESTING.md`** — Test tiers, inventory, update rules, setup
- **`docs/BULK-INGESTION.md`** — Bulk ingestion pipeline, QStash worker chaining, backfill report
- **`docs/WHATSAPP.md`** — WhatsApp daemon API, message flow, scaling

## GDPR Compliance

**Implementation:** `src/lib/db/gdpr.ts` — `deleteAllUserData` (FK-safe cascade across 13 tables), `exportAllUserData`, `writeAuditLog` (never throws), `enforceRetentionPolicy`.

- `POST /api/gdpr/delete` — Art. 17 Right to Erasure. Auth: API key.
- `GET /api/gdpr/export?userId=` — Art. 15 Right of Access. Auth: API key.
- Audit logs survive user deletion (`ON DELETE SET NULL`).

## Concurrency Control

DB-level agent lock (`src/lib/db/locks.ts`) — `tryAcquireUserLock`/`releaseUserLock` with 10-min auto-expiry. Falls back to in-memory Map if migration not applied. Used in `agent.ts` → `runAgentForUser()`.

Migration SQL for locks, audit logs, and enriched_text: See `docs/SCHEMA.md`.

## Parallelism Architecture

All services use **batched `Promise.allSettled`** for fault isolation — one item's failure doesn't block others.

| Service | Pattern | Concurrency | Notes |
|---------|---------|-------------|-------|
| `agent.ts` | Steps 2/2.1/2.5 in parallel | 3 | Inbound, outbound, calendar are independent |
| `planning.ts` | Conversations batched | 5 | Each involves an AI call (proposeAction) |
| `ingestion.ts` | Emails batched (inbound + outbound) | 5 | classifyEmail AI call is the bottleneck |
| `lead-tracking.ts` | Conversations batched | 10 | Independent conversations, DB-heavy |
| `threading.ts` | Pre-assigned lookups + CP fetches | All | `Promise.all` for reads; serial for `assignToConversation` (prevents duplicate creation) |
| `bulk-ingestion.ts` | QStash worker chaining (Vercel) + batched allSettled | 20 parallel / 50 per QStash hop | Phase 1 splits into 50-email hops via QStash; Phases 2–5 each a single hop. Phases 1/2/4 process 20 emails in parallel within each hop |

## Superadmin
- Dashboard at `/superadmin`
- Protected by `SUPERADMIN_KEY` env var (passed via `?key=` or header)
- Shows system health, user stats, and error logs
