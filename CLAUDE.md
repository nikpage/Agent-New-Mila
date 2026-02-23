# CLAUDE.md — Project Guide for Claude Code

## RULES
- NEVER take action (edit files, write code, run commands) without explicit user instruction
- When reporting problems: ONLY list what's wrong and wait
- Ask "Want me to fix this?" and WAIT for "yes"
- Default mode is RESEARCH AND REPORT, not act
- NEVER default to generic patterns. Every decision must be specific to THIS project (Mila, nikpage/Agent-New-Mila, shared multi-tenant deployment)
- NEVER use placeholders, stubs, or "TODO" on the developer side. Use real values, real logic, real implementations
- NEVER take shortcuts that create maintenance debt (e.g., clone-per-client instead of multi-tenant, hardcoded config instead of DB-driven)

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
npm test             # Run Vitest test suite (256 tests)
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
│   ├── scheduling.ts           # Calendar slot finding (683 lines) ⚠️ LARGEST
│   ├── planning.ts             # Action generation with channel detection (parallel batches of 5)
│   ├── threading.ts            # Email/WA conversation grouping (enriched embeddings + external thread ID)
│   ├── ingestion.ts            # Email ingestion (parallel batches of 5)
│   ├── bulk-ingestion.ts       # Historical backfill — 3-phase: fetch → thread → report
│   ├── backfill-report.ts      # "Welcome to Mila" report email after bulk ingestion (772 lines)
│   ├── calendar-ingestion.ts   # Calendar sync + personal event filtering
│   ├── lead-tracking.ts        # Cooling/cold/dead lead detection (parallel batches of 10)
│   └── morning-brief.ts        # Daily summary email (212 lines)
│
├── lib/                        # Shared utilities & integrations
│   ├── db/                     # Supabase CRUD — 11 files, ~2200 lines total
│   ├── google/                 # Google APIs — calendar, gmail, auth, maps
│   ├── supabase/               # Client + types (types.ts = 593 lines)
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
│   │   └── generate.ts         # cleanMessageText (channel-aware), cleanEmailText, generateMessageEmbedding
│   ├── auth/
│   │   ├── tokens.ts           # OAuth state, action tokens, cron validation, trigger tokens, backfill tokens
│   │   └── api.ts              # API key verification middleware
│   └── holidays.ts             # Holiday calendar
│
├── components/                 # React components
│   ├── action/ActionCard.tsx   # Main action UI (337 lines)
│   ├── action/EditForm.tsx     # Action editor (142 lines)
│   └── ui/                     # Button, Card, Badge, Input
│
├── config/
│   ├── client.ts               # Per-client config (identity, business, AI persona, leads, WA, calendar, scoring)
│   ├── ai-models.ts            # 6 AI stages × 3-model fallback chains
│   ├── env.ts                  # Environment config with validation
│   └── theme.ts                # Design tokens
│
└── scripts/
    └── whatsapp-daemon.ts      # Standalone Baileys multi-session WA daemon (excluded from tsconfig)
```

## Agent Pipeline (src/services/agent.ts)

```
Step 0: purgeUserAsCp — data hygiene
Step 1: Verify user exists + has Google credentials
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
- `src/lib/db/` — 11 files, ~2200 lines. Use the index below to pick the right file.
- `src/services/` — 8 files, 2500+ lines. Read only the service relevant to the task.
- `src/lib/google/` — 5 files, 1100+ lines. Read only the API you need.

### Do NOT follow imports into large type files
- `src/lib/supabase/types.ts` (593 lines) — Only read if you need specific type definitions. Use Grep to find the type you need instead.

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
| `counterparties.ts` | `normalizeGmailAddress`, `isSameGmailAddress`, `getCPById`, `getCPByIdentifier`, `upsertCP`, `updateCP`, `blacklistCP`, `getCPsForUser`, `findOrCreateCP`, `purgeUserAsCp`, `getCPState`, `updateCPState` |
| `conversations.ts` | `getConversationById`, `createConversation`, `updateConversation`, `getConversationsForUser`, `addParticipant`, `getRecentMessages`, `findConversationByExternalThread` |
| `messages.ts` | `getMessageById`, `createMessage`, `getMessagesForConversation`, `getUnprocessedMessages` |
| `actions.ts` | `getActionById`, `createAction`, `updateAction`, `getActionsForUser`, `calculatePriorityScore`, `hasPendingAction`, `getPendingActionsForBrief`, `markActionsNotified` |
| `todos.ts` | `getTodoById`, `createTodo`, `updateTodo`, `getTodosForUser` |
| `events.ts` | `getEventById`, `createEvent`, `updateEvent`, `deleteEvent`, `getEventsInRange`, `getEventsForToday`, `getUpcomingEvents`, `findConflicts`, `getLastEventLocation`, `findAvailableSlots`, `createHoldEvent`, `createTravelBuffer`, `cleanupTravelBuffers`, `confirmEvent`, `cancelEventWithCleanup`, `calculateEventScore`, `upsertEventByGoogleId`, `getChildEvents` |
| `embeddings.ts` | `saveMessageEmbedding`, `searchSimilarMessages` |
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

## Database Schema (actual columns from Supabase)

### User Settings (JSONB)
Stored in `users.settings` column. Accessed via `getUserSettings(userId)`.

| Category | Fields | Defaults |
|----------|--------|----------|
| **Work Hours** | `working_hours_start`, `working_hours_end`, `working_days`, `timezone` | 9-17, Mon-Fri, Europe/Prague |
| **Meetings** | `default_meeting_duration`, `default_meeting_type`, `meeting_buffer_minutes` | 30m, online, 15m |
| **Travel** | `travel_mode`, `home_location`, `office_location` | driving |
| **Priorities** | `offer_multiplier_seller`, `offer_multiplier_buyer`, `priority_multiplier_vip`, `kc_factor` | 1.5, 1.0, 2.0, 13 |
| **AI Persona** | `ai_tone_user`, `ai_tone_cp`, `user_alias` | Professional, Polite, "User" |
| **Briefs** | `morning_brief_time`, `afternoon_brief_time` | 08:00, 13:00 |
| **Misc** | `default_delegate_email`, `todo_auto_due_days` | null, 1 |

**Note:** These settings are read at runtime via `getAISystemPrompt(settings)` in `src/config/client.ts`.

### Core Tables

**`users`** — id, email, mila_name, public_name, email_timezone, email_enabled, email_unsubscribed, settings (jsonb), google_oauth_tokens (jsonb), encrypted_google_tokens (text), created_at

**`cps`** (counterparties) — id, user_id, name, primary_identifier, other_identifiers (jsonb), role, locations (jsonb), is_blacklisted, created_at

**`channels`** — id, user_id, type (email/whatsapp), identifier, created_at

**`cp_states`** — cp_id → cps, state, summary_text, last_updated

### Conversation & Messages

**`conversation_threads`** — id, user_id, topic, summary_text, summary_json (jsonb), summary_confidence (numeric), summary_confidence_reason, messages_since_rebuild, message_count, state, deal_type, priority_score (integer), embedding (vector 768-dim), last_updated, created_at

**`messages`** — id, user_id, cp_id, channel_id, thread_id, conversation_id, external_thread_id, universal_message_id, external_id, direction (inbound/outbound), raw_text, cleaned_text, enriched_text, message_type (enum), tag_primary, tag_secondary, timestamp, occurred_at

**`thread_participants`** — thread_id, cp_id, added_at

**`message_embeddings`** — message_id, embedding (vector 768-dim)

### Actions & Execution

**`action_proposals`** — id, user_id, cp_id, conversation_id, action_type (REPLY/SCHEDULE/TODO/DELEGATE), status, rationale, rationale_cs, intent_cs, missing_info (jsonb), payload (jsonb), draft_subject, draft_body_text, user_notes, priority_score (numeric), dollar_value (numeric), urgency (numeric), pain_factor (numeric), weight (numeric), offer_multiplier (numeric), queued_for_brief, last_notified_at, created_at

**`emails`** (outbound send queue) — id, user_id, action_id, to, subject, text_body, html_body, status, external_id, sent_at, bounced, retry_count, last_retry_at, last_error, created_at, updated_at

**`todos`** — id, user_id, cp_id, thread_id, description, status, due_date, scheduled_time, created_at

### Calendar

**`events`** — id, user_id, cp_id, title, description, location, start_time, end_time, event_type (meeting/travel_buffer), status, parent_event_id (self-ref for travel buffers), pre_block_group_id, google_event_id, created_at

### GDPR & Audit

**`audit_logs`** — id, user_id (FK SET NULL — survives user deletion), action, details (jsonb), ip_address, created_at

### Concurrency

**`user_agent_locks`** — user_id (PK, FK CASCADE), locked_at, expires_at (10-min TTL auto-expiry)

### System

**`agent_errors`** — id, user_id, error_id, agent_type, message_internal, message_user, created_at

### Known Redundancy / Unused Columns
- `messages.thread_id` AND `messages.conversation_id` — both FK to `conversation_threads` (redundant)
- `users.google_oauth_tokens` (jsonb) AND `users.encrypted_google_tokens` (text) — migration in progress
- `conversation_threads.priority_score` — integer on thread vs numeric on action_proposals (different scales)
- `users.settings.ai_tone_user/ai_tone_cp/user_alias` — used at runtime via `getAISystemPrompt(settings)` in `client.ts`

### Deal Property Model
- **`conversation_threads.deal_type`** — set by AI during planning (`proposeAction` → `planning.ts`). Values: `sale`, `purchase`, `rental`, `lease`, `consultation`, `other`, or `null`. Type: `DealType` in `types.ts`.
- **`action_proposals.offer_multiplier`** — set during planning from user settings based on CP role. `cp.role === 'seller'` → `offer_multiplier_seller` (default 1.5), otherwise `offer_multiplier_buyer` (default 1.0). Flows into `calculatePriorityScore()`.
- **`action_proposals.dollar_value`** — AI estimates in user's configured currency (from `typical_deal_size_currency`, default CZK). High-value signal detection (`containsHighValueSignals`) flags conversations for the AI to prioritize estimation.
- **CP `role`** — typed as `CPRole`: `seller`, `buyer`, `landlord`, `tenant`, `agent`, `developer`, `other`, or `null`.
- **`payload.action_metadata`** — includes `deal_type`, `offer_multiplier`, `weight`, and `is_high_value` boolean for downstream consumers.

## Priority Scoring

**Formula:** `(dollarValue / kcFactor × offerMultiplier × urgency) + (painFactor × (daysIgnored + 1)²) + weight`

**Implementation:** `src/lib/db/actions.ts` → `calculatePriorityScore()`

| Input | Scale | Notes |
|-------|-------|-------|
| `dollarValue` | 0+ (CZK) | Deal/transaction value |
| `kcFactor` | default 13 | Fibonacci-based normalization constant from `settings.kc_factor`. Divides raw dollar value so scores are comparable across deal size scales. |
| `offerMultiplier` | default 1 | From user settings: `offer_multiplier_seller` (1.5) or `offer_multiplier_buyer` (1.0) based on CP role |
| `urgency` | 1-10 | AI-assessed, safe default 1 |
| `painFactor` | 1-10 | AI-assessed relationship pain, safe default 1 |
| `daysIgnored` | 0+ | Days since last activity (squared growth) |
| `weight` | 0-100 | AI-assessed immovability (100 = legal deadline, 0 = flexible). Set during proposal generation. |

Safe defaults: `urgency`, `painFactor`, `offerMultiplier`, `kcFactor` fallback to 1 if 0/null (prevents score collapse / division by zero).

**DO NOT REMOVE OR CHANGE** the `kcFactor` normalization or `weight` wiring without explicit user permission. These were deliberately connected in Feb 2025 to fix scoring bugs where raw CZK values dominated all other factors and AI-assessed immovability was silently discarded.

**Wiring:** `planning.ts` passes `offerMultiplier` (from CP role), `kcFactor` (from user settings), and `weight` (from AI response) to `calculatePriorityScore()`. `lead-tracking.ts` also passes `offerMultiplier` and `kcFactor` for follow-up actions.

## AI Model Configuration

**Config:** `src/config/ai-models.ts` — 6 pipeline stages, each with 3-model fallback chain.
**Runner:** `src/lib/ai/runner.ts` → `runAITask(stage, prompt)` — auto-cascades on failure, retries 429s with exponential backoff (1s, 2s, 4s), logs which model succeeded.

| Stage | Purpose | Primary → Fallback1 → Fallback2 |
|-------|---------|----------------------------------|
| `preFilter` | Spam detection | `gemini-2.5-flash-lite` → `claude-haiku-4-5-20251001` |
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

**Business context injection:** `getAISystemPrompt()` from `src/config/client.ts` is prepended to `proposeAction()` and `generateFinalDraft()` prompts. Channel context (email vs WhatsApp) adjusts tone. High-value signal detection (`containsHighValueSignals`) flags conversations in the `proposeAction` prompt. AI estimates `dollarValue` and `weight` (0-100 immovability) in the user's configured currency with typical deal range as reference, and classifies `dealType`.

## Embeddings & Semantic Threading

**Purpose:** Assign incoming messages to existing conversations when external thread ID doesn't match. Supports cross-channel matching (WhatsApp message finds its email conversation).

**Per-message enrichment** (`enrichMessage` in `gemini.ts`):
- Runs after cleaning, before threading. Extracts: who's involved, property/subject, message kind, deal numbers, core intent.
- Saves to `messages.enriched_text` column. Embedding generated from enriched text (not raw body).
- Stage: `enrichment` (gemini-2.5-flash-lite → gemini-2.5-flash). Cost-sensitive — runs per message.
- Runs in **both** regular ingestion (`ingestion.ts`) **and** bulk historical ingestion (`bulk-ingestion.ts`). Bulk enrichment tracks success/failure counts (`enriched`, `enrichmentFailed` in `BulkIngestionPhase1Result`).

**Pipeline** (`src/services/threading.ts`):
1. **External thread ID match** (primary) — exact match on `external_thread_id` (Gmail thread ID, Exchange conversation ID, `wa:+phone`)
2. **Enriched embedding similarity** (secondary) — cosine similarity of enriched message embedding against conversation embeddings, same CP only
3. **New conversation** (fallback) — if nothing matches. Creates thin-conversation ToDo if enrichment yielded < 100 chars.

**Thresholds:**
- `≥ 0.78` → auto-join conversation (no AI needed)
- `0.55 – 0.78` → AI tiebreak via `shouldJoinConversation()`
- `< 0.55` → new conversation

**WhatsApp threading:** By phone number — `external_thread_id = wa:+phone`

**Conversation summaries** use enriched messages (adaptive count: enough to reach ~1500 chars). Falls back to cleaned_text for older un-enriched messages. Embedding generated from summary text.

**Channel-aware cleaning** (`cleanMessageText` in `generate.ts`):
- `email`/`email/gmail`: Full cleaning (signatures, quoted replies, disclaimers, tracking pixels)
- `email/exchange`: Gmail base + Outlook-specific patterns (EXTERNAL EMAIL banners, From/Sent/To headers, aka.ms links)
- `whatsapp`: Minimal — system messages and forwarded labels only
- `cleanEmailText()` is a backward-compatible alias for `cleanMessageText(text, 'email')`

## Scheduling & Conflict Resolution

**Implementation:** `src/services/scheduling.ts` (683 lines — largest service)

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

Proposal phase stores: `intent_cs`, `rationale_cs`, `missing_info`, `dollar_value`, `offer_multiplier`, `weight`. Draft fields (`draft_subject`, `draft_body_text`) are null until execution. Channel is stored in `payload.channel`. Deal context (`deal_type`, `weight`, `is_high_value`) is stored in `payload.action_metadata`.

`generateFinalDraft()` in `src/lib/ai/gemini.ts` takes conversation context + intent + user notes + channel → returns `{ subject, body }`.

## Bulk Ingestion & Backfill Report

### Bulk Ingestion (`src/services/bulk-ingestion.ts`)
Historical backfill — imports a user's email history and sets up Mila's understanding of their conversations.

**Route:** `POST /api/ingest/bulk` (API key auth, 5-min timeout). Streams NDJSON progress events: `started`, `progress`, `done`, `error`.

**3-phase pipeline:**
1. **Phase 1 — Fetch & Store:** Paginates through INBOX + SENT. Skips blocked senders, Gmail categories (PROMOTIONS, SOCIAL, etc.), duplicates. Runs `preFilterEmail()` AI + `enrichMessage()` AI per email. Tracks: `inboxFetched`, `sentFetched`, `skippedCategory`, `skippedBlocked`, `skippedPreFilter`, `skippedDuplicate`, `enriched`, `enrichmentFailed`, `stored`.
2. **Phase 2 — Thread:** Calls `processMessagesForThreading()` on all stored messages (chronological). Same threading logic as agent Step 4.
3. **Phase 3 — Backfill Report:** Generates and sends a "Welcome to Mila" summary email.

**Filtered senders** are tracked (email + count + reason) and passed to the backfill report for "Allow as Contact" links.

### Backfill Report (`src/services/backfill-report.ts`)
Generates a comprehensive HTML email sent from the user's Gmail to themselves. Sections:
- **Inbox health:** totals, inbound/outbound ratio
- **Filtered senders:** blocked/pre-filtered emails with "Allow as Contact" signed links
- **Counterparties:** discovered contacts with message counts, deal stage, "Blacklist" links
- **Conversations:** threads with summary, CP names, lead status, "Add to Mila" links
- **Unanswered inbound:** emails from last 7 days with no outbound reply
- **Calendar:** upcoming events (next 2 weeks)
- **Leads:** cooling/cold/dead lead alerts

### Backfill Action Handler (`src/app/api/backfill/action/route.ts`)
Handles signed GET links from the report email. Operations:
- `allow` — creates CP from a previously-filtered sender email
- `blacklist` — blacklists an existing CP
- `add` — generates action proposals for a conversation (enters Mila process)
- `setrole` — sets a CP's role (e.g., `buyer`, `seller`)

Authentication via HMAC-signed backfill tokens (`generateBackfillToken`/`validateBackfillToken` in `src/lib/auth/tokens.ts`). All operations are idempotent.

## WhatsApp Integration

### Architecture
- **Daemon** (`scripts/whatsapp-daemon.ts`) — standalone process, NOT part of Next.js build (excluded in tsconfig)
- Uses `@whiskeysockets/baileys` (pure WebSocket, NO Puppeteer/Chromium) — ~5-10 MB per session
- **Multi-session**: one Baileys connection per user, managed in a `Map<userId, socket>`
- Auth state persisted per user in `./baileys_auth/<userId>/`
- Requires separate `npm install @whiskeysockets/baileys pino qrcode-terminal`
- Run with: `npx tsx scripts/whatsapp-daemon.ts`

### Daemon HTTP API (default port 3001)
- `GET /health` — alive check + session/connected counts
- `GET /sessions` — list all user sessions (userId, connected, phone, hasQr, error)
- `GET /status/:userId` — per-user connection status + QR code for pairing
- `POST /sessions/:userId/connect` — initiate new session (returns 202, poll `/status/:userId` for QR)
- `DELETE /sessions/:userId` — disconnect and remove a session
- `POST /send { userId, to, body }` — send message via specific user's session

### Message Flow
1. Daemon receives WA message via Baileys event → writes to Supabase `messages` table (`channel_id: 'whatsapp'`, `external_thread_id: wa:+phone`)
2. Agent pipeline picks up WA messages in Step 3 (same as email)
3. Threading groups by phone number
4. AI receives channel context, adjusts tone
5. On execution, sender calls daemon's `/send` endpoint with `userId` to route to correct session

### Multi-Session Scaling
- No Puppeteer/Chromium — pure WebSocket connections
- ~5-10 MB RAM per session (vs 150-300 MB with whatsapp-web.js)
- 50-100 concurrent users comfortably on a single server
- On startup, daemon scans `./baileys_auth/` and auto-reconnects all existing sessions
- Staggered reconnect (2s delay) to avoid hammering WA servers

### Configuration
All in `src/config/client.ts` → `whatsapp` section:
- `enabled`, `sessionDataPath`, `daemonPort`, `autoAckMessage`, `blockedNumbers`, `monitoredGroups`

## Conventions
- All server-side code uses `async/await` with Supabase client
- Error handling: check `error` from Supabase responses, throw with descriptive messages
- API routes use Next.js App Router conventions (`route.ts` with exported HTTP method functions)
- Components use Tailwind CSS classes (no CSS modules)
- Type imports use `import type { ... }` syntax
- Tests use Vitest — test files are co-located with source (`*.test.ts`). See **Testing** section below for sync rules

## Testing

**Framework:** Vitest 4 with `@/*` path aliases (`vitest.config.ts`). Tests are co-located next to source files (`foo.ts` → `foo.test.ts`).

### Run
```bash
npm test             # All tests (CI mode, exits with code)
npm run test:watch   # Watch mode (re-runs on save)
npm run test:coverage # With v8 coverage report
```

### Test Layers (256 tests + 10 smoke tests)

Tests are organized in four layers. All must pass before any commit.

#### Layer 1: Route Protection (34 tests)
**File:** `src/app/api/__tests__/route-protection.test.ts`

Every API route is tested to verify it rejects unauthenticated/bad requests. Catches: accidentally removed auth checks, changed HTTP methods, broken request parsing.

- API key routes: `/api/agent/run`, `/api/gdpr/delete`, `/api/gdpr/export`, `/api/ingest`, `/api/ingest/bulk`, `/api/whatsapp/status`
- Cron routes: `/api/cron/morning-brief` (GET + POST), `/api/ingest/bulk/worker` (no token + bad token)
- Action token routes: `/api/action/[id]`, `/api/action/[id]/execute`, `/api/action/[id]/draft`, `/api/action/[id]/blacklist`, `/api/action/[id]/todo`
- Superadmin: `/api/superadmin/stats`
- Trigger pixel: `/api/trigger/ingest` — verifies it returns GIF but does NOT run agent with bad sig
- Backfill: `/api/backfill/action` — rejects missing params and bad signatures
- Auth: `/api/auth/connect` (email validation), `/api/auth/callback` (state validation)

#### Layer 2: Behavior Pinning (72 tests)

**Catches unauthorized changes to scoring, thresholds, defaults, or business logic.**

| File | Tests | What it pins |
|------|-------|-------------|
| `src/lib/supabase/defaults.test.ts` | 47 | Every single field in `DEFAULT_USER_SETTINGS` — exact values. Also pins field count (56) to catch added/removed fields. |
| `src/services/lead-tracking.test.ts` | 12 | Lead thresholds (2/5/14 days), boost multipliers (1.5x/2.5x/3.75x), urgency/pain mappings, threshold ordering |
| `src/services/scheduling.test.ts` | 9 | Meeting duration, buffer, working hours, working days, timezone, travel mode defaults |
| `src/services/morning-brief.test.ts` | 4 | Brief times (08:00/13:00), concurrency limit (10), max actions per brief (10) |

#### Layer 3: Logic Tests (127 tests)

| Source file | Test file | What's tested |
|-------------|-----------|---------------|
| `src/lib/auth/tokens.ts` | `tokens.test.ts` | 20 tests — HMAC round-trip, expiry, tampering, missing secret, malformed input. **Protects every approve/reject button in brief emails.** |
| `src/services/agent.ts` | `agent.test.ts` | 12 tests — Lock acquire/release/fallback, user-not-found, no-credentials, fault isolation (`Promise.allSettled` not `Promise.all`) |
| `src/services/planning.ts` | `planning.test.ts` | 11 tests — `validateDealType`: valid/invalid/hallucinated values, `selectOfferMultiplier`: seller/buyer/null role selection, `VALID_DEAL_TYPES`/`VALID_CP_ROLES` pinning, seller vs buyer priority score difference |
| `src/lib/db/actions.ts` | `actions.test.ts` | 13 tests — `calculatePriorityScore` formula: zero-safety fallbacks, quadratic `daysIgnored` growth, multipliers, integer rounding, `kcFactor` normalization + zero-safety, `weight` wiring |
| `src/services/ingestion.ts` | `ingestion.test.ts` | 8 tests — `isBlockedSender`: exact/prefix/domain/subaddress matching, false-positive prevention (`mynotifications` ≠ `notifications`) |
| `src/config/client.ts` | `client.test.ts` | 10 tests — `containsHighValueSignals` + `isPersonalEvent`: keyword matching, case-insensitivity, empty inputs, empty keyword lists |
| `src/lib/db/counterparties.ts` | `counterparties.test.ts` | 11 tests — `isSameGmailAddress`: dot/case-insensitive, domain dots, whitespace trimming; `normalizeGmailAddress`: lowercasing, dot stripping, idempotency, missing `@` |
| `src/lib/embeddings/generate.ts` | `generate.test.ts` | 30 tests — `cleanEmailText` (13 original), `cleanMessageText` channel-aware: Exchange (EXTERNAL banners, Outlook headers, aka.ms, Get Outlook), WhatsApp (system msgs, forwarded labels, no false stripping), backward-compatible alias, unknown channel fallback |
| `src/lib/whatsapp/types.ts` | `types.test.ts` | 6 tests — `normalizePhoneNumber`, `phoneToThreadId`: separator stripping, `+` prefix, thread ID format |
| `src/lib/db/gdpr.ts` | `gdpr.test.ts` | 4 tests — `writeAuditLog` never-throw contract, `deleteAllUserData` FK-safe ordering, missing lock table graceful handling |
| `src/lib/db/locks.ts` | `locks.test.ts` | 2 tests — unique violation → `false` (error code `23505`), `releaseUserLock` filters by `user_id` |

#### Layer 4: Integration Tests (25 tests)

**Verify that services wire together correctly — mock at boundaries (DB, AI, Google APIs) but let service code chain for real.**

| File | Tests | What's tested |
|------|-------|---------------|
| `src/services/agent-pipeline.test.ts` | 5 | Agent pipeline data flow: emails → threading → planning, calendar + lead tracking aggregation, step 2 fault isolation, step 4-5 skip on empty, WhatsApp message counting |
| `src/services/integration.test.ts` | 20 | **Planning:** conversation → AI → scored action in DB, blacklisted CP skipped, weight clamping. **Morning Brief:** action loading + CP enrichment + email send, unsubscribed skip, empty brief, 10-action cap, afternoon greeting, multi-user fault isolation. **Bulk Ingestion:** 3-phase pipeline (fetch → thread → report), blocked sender skip, category skip, early return on errors, enrichment tracking. **Ingestion → Threading:** classify + store + enrich, non-actionable skip, blocked sender skip, duplicate skip, external thread ID match, new conversation creation |

#### Layer 5: Smoke Tests (10 tests, opt-in)
**File:** `src/__tests__/smoke.test.ts`

Real HTTP calls against a running instance. Skipped by default. Reads `MILA_USER_API_KEY` and `CRON_SECRET` from `.env.local`. Run with:
```bash
SMOKE_TEST=1 npm test -- src/__tests__/smoke.test.ts
```

Test user: `podtwo@gmail.com` (`d1a403fd-121b-4dcc-96aa-0efa3af114a8`)

Tests: health check, auth rejection (live), agent run, morning brief, GDPR export, WhatsApp status, trigger pixel.

Set `SMOKE_BASE_URL` to target prod (defaults to `http://localhost:3000`).

### When to update tests

1. **You changed a function's behavior** → Update the test that pins the old behavior. If the test still passes after your change, the test wasn't covering what you changed — add a test that does.

2. **You changed any default setting value** → Update `defaults.test.ts` with the new value AND the field count.

3. **You added a new API route** → Add auth rejection tests in `route-protection.test.ts`.

4. **You added a new exported function** to an already-tested file → Add tests in the existing `.test.ts` file.

5. **You created a new file with deterministic logic** (pure functions, formulas, matching rules, crypto) → Create a co-located `.test.ts` file.

6. **You changed orchestration flow** (error handling paths, parallel vs serial, lock behavior, retry logic) → Update or add tests in the relevant service test file.

### When NOT to add tests

- **AI prompt text** — changes constantly, not deterministic, not testable by string matching
- **"Did you call the right Supabase method" tests** — these test code structure not behavior. Test the *behavioral outcome* instead.

### Run `npm test` before every commit. Tests must pass alongside `npm run build`.

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

## Bulk Ingestion via QStash

### Problem
Bulk historical email ingestion (500+ emails) exceeds Vercel's 300-second function timeout when running as a single request.

### Solution: QStash Worker Chaining
When `QSTASH_TOKEN` is set (Vercel), `/api/ingest/bulk` splits the work into chained QStash messages. Each step runs within the 300s timeout. Without `QSTASH_TOKEN` (local dev), falls back to synchronous NDJSON streaming.

### Architecture
```
POST /api/ingest/bulk (orchestrator)
  ├─ Validates input, resolves user email, purges user-as-CP
  ├─ Publishes first QStash step → returns 202 immediately
  │
  ▼ QStash worker chain (/api/ingest/bulk/worker)
  │
  ├─ phase1_inbox  ─► fetch 50 inbox emails, preFilter+store, chain next page
  │   └─ repeats until maxTotal reached or no more pages
  ├─ phase1_sent   ─► fetch 50 sent emails, preFilter+store, chain next page
  │   └─ repeats until maxTotal reached or no more pages
  ├─ phase2        ─► thread all unprocessed messages into conversations
  ├─ phase3        ─► generate & send backfill report email to user
  └─ phase4        ─► enrich stored messages (classify + embed)
```

### Key Details
- **Batch size:** 50 emails per QStash hop (Phase 1)
- **Budget:** 500 emails ≈ 12 QStash calls (10 for Phase 1 + 1 each for Phase 2–4)
- **State passing:** Job state (stats, filteredSenders, pageToken) is passed in the QStash message body between hops
- **Auth:** Worker endpoint uses `CRON_SECRET` Bearer token (same as morning-brief)
- **Orchestrator returns:** `{ started: true, mode: "queued", qstashMessageId }` with HTTP 202
- **Idempotency:** Phase 1 dedup via `messageExists()` prevents double-storing on QStash retry

### Implementation
- **Orchestrator:** `src/app/api/ingest/bulk/route.ts` — QStash path (with `QSTASH_TOKEN`) or NDJSON fallback
- **Worker:** `src/app/api/ingest/bulk/worker/route.ts` — state machine handling all 5 steps
- **Batch fetch:** `fetchEmailsBatch()` in `src/lib/google/gmail.ts` — single-page Gmail fetch with `nextPageToken`
- **Batch process:** `processEmailBatch()` in `src/services/bulk-ingestion.ts` — dedup, filter, preFilter AI, store
- **QStash publish:** `publishBulkIngestStep()` in `src/lib/qstash/client.ts`

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

## GDPR Compliance

### Endpoints
- **`POST /api/gdpr/delete`** — Art. 17 Right to Erasure. Cascade-deletes all user data across 13 tables in FK-safe order. Body: `{ userId }`. Auth: API key.
- **`GET /api/gdpr/export?userId=`** — Art. 15 Right of Access. Returns full data export as JSON. Auth: API key.

### Implementation (`src/lib/db/gdpr.ts`)
- `writeAuditLog(entry)` — writes to `audit_logs` table (never throws)
- `exportAllUserData(userId)` — gathers data from all tables for one user
- `deleteAllUserData(userId)` — FK-safe cascade: emails → embeddings → actions → participants → messages → todos → events → cp_states → conversations → cps → channels → errors → locks → user
- `enforceRetentionPolicy(userId, days)` — scrubs `raw_text`/`cleaned_text` from messages older than retention window, deletes their embeddings. Preserves message metadata for conversation continuity.

### Audit Logging
All GDPR operations (export, delete) write to `audit_logs` before and after execution. The `user_id` FK uses `ON DELETE SET NULL` so audit entries survive user deletion.

### Required Migration
```sql
CREATE TABLE audit_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb,
  ip_address text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
```

## Concurrency Control

### DB-Level Agent Lock
Replaces the old in-memory `runningUsers` Map which only worked within a single Vercel serverless instance.

**Implementation:** `src/lib/db/locks.ts`
- `tryAcquireUserLock(userId)` — inserts row into `user_agent_locks` table; returns `false` if row already exists (lock held)
- `releaseUserLock(userId)` — deletes the lock row
- **Auto-expiry:** locks older than 10 minutes are cleaned up before acquire (handles crashed instances)
- **Fallback:** if the `user_agent_locks` table doesn't exist yet (migration not applied), falls back to in-memory Map

**Used in:** `src/services/agent.ts` → `runAgentForUser()`

### Required Migrations
```sql
CREATE TABLE user_agent_locks (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  locked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- Per-message enrichment (enriched key info extracted by AI)
ALTER TABLE messages ADD COLUMN enriched_text text;
CREATE INDEX idx_messages_enriched_null
  ON messages (user_id, created_at)
  WHERE enriched_text IS NULL;
```

## Parallelism Architecture

All services use **batched `Promise.allSettled`** for fault isolation — one item's failure doesn't block others.

| Service | Pattern | Concurrency | Notes |
|---------|---------|-------------|-------|
| `agent.ts` | Steps 2/2.1/2.5 in parallel | 3 | Inbound, outbound, calendar are independent |
| `planning.ts` | Conversations batched | 5 | Each involves an AI call (proposeAction) |
| `ingestion.ts` | Emails batched (inbound + outbound) | 5 | classifyEmail AI call is the bottleneck |
| `lead-tracking.ts` | Conversations batched | 10 | Independent conversations, DB-heavy |
| `threading.ts` | Pre-assigned lookups + CP fetches | All | `Promise.all` for reads; serial for `assignToConversation` (prevents duplicate creation) |
| `bulk-ingestion.ts` | QStash worker chaining (Vercel) | 50/batch | Phase 1 splits into 50-email hops via QStash; Phases 2–4 each a single hop |

## Superadmin
- Dashboard at `/superadmin`
- Protected by `SUPERADMIN_KEY` env var (passed via `?key=` or header)
- Shows system health, user stats, and error logs
