# CLAUDE.md — Project Guide for Claude Code

## Project Overview
**Mila** is an AI-powered executive assistant that ingests emails/calendars via Google Workspace APIs, uses Gemini AI to propose actions (reply, schedule, wait, delegate), and presents them for user approval.

- **Stack**: Next.js 14 (App Router) / TypeScript 5.7 (strict) / Supabase / Tailwind CSS 3
- **AI**: Google Generative AI (Gemini) via `@google/generative-ai`
- **Deployment**: Vercel with cron jobs
- **Monitoring**: Sentry error tracking (client + server + edge)
- **Path alias**: `@/*` → `src/*`

## Commands
```bash
npm run build        # Production build (the primary check — catches type errors + lint)
npm run typecheck    # TypeScript only: tsc --noEmit
npm run lint         # ESLint via next lint
npm run dev          # Dev server (uses 8GB heap)
```
**Always run `npm run build` after making changes** to verify nothing is broken. If build passes, the code is good.

## Architecture Map

```
src/
├── app/                        # Next.js App Router (pages + API routes)
│   ├── api/agent/run/          # Main agent orchestration endpoint
│   ├── api/action/[id]/        # Action CRUD + execute/draft/todo/blacklist
│   ├── api/auth/               # OAuth connect + callback
│   ├── api/cron/morning-brief/ # Daily 8 AM cron
│   ├── api/ingest/             # Manual email/calendar ingestion
│   ├── api/health/             # Health check
│   ├── action/[id]/            # Action detail + edit pages
│   └── page.tsx                # Home/status dashboard
│
├── services/                   # Business logic (orchestration layer)
│   ├── agent.ts                # Main pipeline (~120 lines)
│   ├── scheduling.ts           # Calendar slot finding (683 lines) ⚠️ LARGEST
│   ├── planning.ts             # Action generation (235 lines)
│   ├── threading.ts            # Email conversation grouping (306 lines)
│   ├── ingestion.ts            # Email ingestion (225 lines)
│   ├── calendar-ingestion.ts   # Calendar sync (297 lines)
│   └── morning-brief.ts        # Daily summary (212 lines)
│
├── lib/                        # Shared utilities & integrations
│   ├── db/                     # Supabase CRUD — 9 files, 1892 lines total
│   ├── google/                 # Google APIs — calendar, gmail, auth, maps
│   ├── supabase/               # Client + types (types.ts = 593 lines)
│   ├── ai/gemini.ts            # Gemini AI calls (228 lines)
│   ├── auth/
│   │   ├── tokens.ts           # OAuth state, action tokens, cron validation
│   │   └── api.ts              # API key verification middleware
│   └── holidays.ts             # Holiday calendar
│
├── components/                 # React components
│   ├── action/ActionCard.tsx   # Main action UI (337 lines)
│   ├── action/EditForm.tsx     # Action editor (142 lines)
│   └── ui/                     # Button, Card, Badge, Input
│
└── config/
    ├── env.ts                  # Environment config with validation
    └── theme.ts                # Design tokens
```

## Performance Rules (CRITICAL)

### Do NOT bulk-read directories
Never read all files in a directory sequentially. This bloats context and causes hangs.

**Worst offenders (do NOT read all files in these):**
- `src/lib/db/` — 9 files, 1892 lines. Use the index below to pick the right file.
- `src/services/` — 8 files, 2000+ lines. Read only the service relevant to the task.
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

| File | Lines | Contents |
|------|-------|----------|
| `users.ts` | 146 | `getUserById`, `getUserByEmail`, `createUser`, `updateUser`, `getUserSettings`, `updateUserSettings` |
| `counterparties.ts` | 203 | `getCPById`, `getCPByIdentifier`, `createCP`, `updateCP`, `getCPsForUser` |
| `conversations.ts` | 289 | `getConversationById`, `createConversation`, `updateConversation`, `getConversationsForUser`, `addParticipant` |
| `messages.ts` | 222 | `getMessageById`, `createMessage`, `getMessagesForConversation`, `getRecentMessages` |
| `actions.ts` | 288 | `getActionById`, `createAction`, `updateAction`, `getActionsForUser`, `calculatePriorityScore` |
| `todos.ts` | 206 | `getTodoById`, `createTodo`, `updateTodo`, `getTodosForUser` |
| `events.ts` | 439 | `getEventById`, `createEvent`, `updateEvent`, `getEventsForUser`, `getEventsInRange` |
| `embeddings.ts` | 91 | `saveMessageEmbedding`, `searchSimilarMessages` |
| `index.ts` | 8 | Barrel re-exports (do not read — it just re-exports the above) |

All db files follow the same pattern: import `getSupabaseAdmin` from `../supabase/client`, import types from `../supabase/types`, export async CRUD functions.

**⚠️ SECURITY:** When adding new queries, always filter by `user_id` unless specifically needed:
```typescript
// ✅ GOOD
const actions = await supabase.from('action_proposals').select('*').eq('user_id', userId)

// ❌ BAD (exposes all users' data)
const actions = await supabase.from('action_proposals').select('*')
```

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
| **Misc** | `morning_brief_time`, `default_delegate_email`, `todo_auto_due_days` | 08:00, null, 1 |

**⚠️ `ai_tone_user`, `ai_tone_cp`, `user_alias`** are defined but **NOT YET wired** into AI prompts.

### Core Tables

**`users`** — id, email, mila_name, public_name, email_timezone, email_enabled, email_unsubscribed, settings (jsonb), google_oauth_tokens (jsonb), encrypted_google_tokens (text), created_at

**`cps`** (counterparties) — id, user_id, name, primary_identifier, other_identifiers (jsonb), role, locations (jsonb), is_blacklisted, created_at

**`channels`** — id, user_id, type (email/whatsapp), identifier, created_at

**`cp_states`** — cp_id → cps, state, summary_text, last_updated

### Conversation & Messages

**`conversation_threads`** — id, user_id, topic, summary_text, summary_json (jsonb), summary_confidence (numeric), summary_confidence_reason, messages_since_rebuild, message_count, state, deal_type, priority_score (integer), embedding (vector 768-dim), last_updated, created_at

**`messages`** — id, user_id, cp_id, channel_id, thread_id → conversation_threads, conversation_id → conversation_threads, external_thread_id (gmail thread id), universal_message_id, external_id, direction (inbound/outbound), raw_text, cleaned_text, message_type (enum), tag_primary, tag_secondary, timestamp, occurred_at

**`thread_participants`** — thread_id → conversation_threads, cp_id → cps, added_at

**`message_embeddings`** — message_id → messages, embedding (vector 768-dim)

### Actions & Execution

**`action_proposals`** — id, user_id, cp_id, conversation_id, action_type (REPLY/SCHEDULE/TODO/DELEGATE), status, rationale, rationale_cs, intent_cs, missing_info (jsonb), payload (jsonb), draft_subject, draft_body_text, user_notes, priority_score (numeric), dollar_value (numeric), urgency (numeric), pain_factor (numeric), weight (numeric), offer_multiplier (numeric), queued_for_brief, last_notified_at, created_at

**`emails`** (outbound send queue) — id, user_id, action_id → action_proposals, to, subject, text_body, html_body, status, external_id, sent_at, bounced, retry_count, last_retry_at, last_error, created_at, updated_at

**`todos`** — id, user_id, cp_id, thread_id, description, status, due_date, scheduled_time, created_at

### Calendar

**`events`** — id, user_id, cp_id, title, description, location, start_time, end_time, event_type (meeting/travel_buffer), status, parent_event_id (self-ref for travel buffers), pre_block_group_id, created_at

### System

**`agent_errors`** — id, user_id, error_id, agent_type, message_internal, message_user, created_at

### Known Redundancy / Unused Columns
- `messages.thread_id` AND `messages.conversation_id` — both FK to `conversation_threads` (redundant)
- `users.google_oauth_tokens` (jsonb) AND `users.encrypted_google_tokens` (text) — migration in progress from plaintext to encrypted
- `conversation_threads.priority_score` — integer on thread vs numeric on action_proposals (different scales?)

## Priority Scoring

**Formula:** `(dollarValue × offerMultiplier × urgency) + (painFactor × (daysIgnored + 1)²) + weight`

**Implementation:** `src/lib/db/actions.ts` → `calculatePriorityScore()`

| Input | Scale | Notes |
|-------|-------|-------|
| `dollarValue` | 0+ (CZK) | Deal/transaction value |
| `offerMultiplier` | default 1 | From user settings: `offer_multiplier_seller` (1.5) or `offer_multiplier_buyer` (1.0) |
| `urgency` | 1-10 | AI-assessed, safe default 1 |
| `painFactor` | 1-10 | AI-assessed relationship pain, safe default 1 |
| `daysIgnored` | 0+ | Days since last activity (squared growth) |
| `weight` | 1-10, or **100** = immovable | How "movable" the event is. Flight departures, kids concert = 100. Default 0 (additive bonus). |

**Safe defaults:** `urgency`, `painFactor`, `offerMultiplier` fallback to 1 if 0/null (prevents score collapse).

**⚠️ Currently:** `planning.ts` calls `calculatePriorityScore()` WITHOUT `weight` or `offerMultiplier` — those are set separately, not yet wired into proposal generation.

## AI Model Configuration

**Config:** `src/config/ai-models.ts` — 6 pipeline stages, each with 3-model fallback chain.
**Runner:** `src/lib/ai/runner.ts` → `runAITask(stage, prompt)` — auto-cascades on failure, logs which model succeeded.

| Stage | Purpose | Primary → Fallback1 → Fallback2 |
|-------|---------|----------------------------------|
| `preFilter` | Spam detection | `gemini-2.5-flash` → `2.0-flash` → `1.5-flash` |
| `classify` | Email category + priority | same chain |
| `threading` | extractTopic, shouldJoinConversation | same chain |
| `analysis` | analyzeConversation | same chain |
| `planning` | proposeAction (type, rationale, intent) | same chain |
| `drafting` | generateFinalDraft, generateBriefHeadline | same chain |

**Embedding model:** `gemini-embedding-001` (768-dim, multilingual) — separate from chat, NO fallback chain.

**Provider:** `src/lib/ai/providers/gemini.ts` — uses `@google/generative-ai` SDK with model caching.

## Embeddings & Semantic Threading

**Purpose:** Assign incoming messages to existing conversations when Gmail thread ID doesn't match.

**Pipeline** (`src/services/threading.ts`):
1. **Gmail thread ID match** (primary) — exact match on `external_thread_id`
2. **Embedding similarity** (secondary) — cosine similarity against `conversation_threads.embedding` for same CP
3. **New conversation** (fallback) — if nothing matches

**Thresholds:**
- `≥ 0.78` → auto-join conversation (no AI needed)
- `0.55 – 0.78` → AI tiebreak via `shouldJoinConversation()`
- `< 0.55` → new conversation

**Conversation embeddings** are regenerated on summary rebuild (`rebuildConversationSummary()`). Embedding failure doesn't block summary updates.

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
- Creates `🚗 Travel to {title}` buffer events linked via `parent_event_id`
- Travel mode from user settings: driving/walking/transit/bicycling

### Priority-Based Conflict Resolution
When a new meeting conflicts with existing events:
- `handleConflict()` compares `calculateEventScore()` of new vs existing
- **New score > existing score** → `recommendation: 'move_existing'` (suggest moving the lower-priority meeting)
- **New score ≤ existing score** → `recommendation: 'suggest_alternate'` (find different time)
- **User-created events default weight = 100** (treated as immovable unless outranked)
- If ALL conflicts recommend moving → slot is still offered with conflict info

### Personal Calendar Events
- Personal/private calendar events **block time** (included in availability calculation)
- **DO generate actions** for personal calendar events
- Currently no visibility/privacy field parsed from Google Calendar API — all events treated equally

## Draft Generation

**Timing:** On-demand only — drafts are generated at execution time, NOT during proposal creation.
**Language:** Czech (hardcoded in prompts)
**Channel-aware tone:** NOT YET IMPLEMENTED — same professional tone for all channels

Proposal phase stores only: `intent_cs`, `rationale_cs`, `missing_info`. Draft fields (`draft_subject`, `draft_body_text`) are null until execution.

`generateFinalDraft()` in `src/lib/ai/gemini.ts` takes conversation context + intent + user notes → returns `{ subject, body }`.

## Conventions
- All server-side code uses `async/await` with Supabase client
- Error handling: check `error` from Supabase responses, throw with descriptive messages
- API routes use Next.js App Router conventions (`route.ts` with exported HTTP method functions)
- Components use Tailwind CSS classes (no CSS modules)
- Type imports use `import type { ... }` syntax
- No test framework is configured — verify changes with `npm run build`

## Security & Authentication

### Authentication Model
**Email Ownership via Google OAuth** — Users authenticate by connecting their Google account. Ownership of Gmail/Calendar proves identity.

### API Protection
All API endpoints are protected by one of:
1. **API Key** (`MILA_USER_API_KEY`) — For `/api/agent/run`, `/api/ingest`
2. **Cron Secret** (`CRON_SECRET`) — For `/api/cron/*`
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
```

**⚠️ SECURITY:** OAuth tokens migrating from `users.google_oauth_tokens` (plaintext jsonb) to `users.encrypted_google_tokens` (encrypted text). See `SECURITY.md`.

## Error Monitoring (Sentry)
- **Client-side:** Session replay + error tracking
- **Server-side:** API route errors, database issues
- **Edge runtime:** Middleware errors
- **Config:** `instrumentation.ts`, `instrumentation-client.ts`, `sentry.*.config.ts`
- **Global handler:** `src/app/global-error.tsx` (React error boundary)

**Setup:** Requires `SENTRY_DSN` env var. Free tier = 5k errors/month.

## Documentation Files
- **`SECURITY.md`** (481 lines) — Security architecture, risks, incident response
- **`DEPLOYMENT.md`** (373 lines) — Deployment guide, backups, operations
- **`CLAUDE.md`** (this file) — Code architecture reference
- **`.env.example`** — All environment variables with generation commands

## Superadmin
- Dashboard at `/superadmin`
- Protected by `SUPERADMIN_KEY` env var (passed via `?key=` or header)
- Shows system health, user stats, and error logs
