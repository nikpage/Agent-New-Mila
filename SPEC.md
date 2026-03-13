# SPEC.md — Mila Product Specification

## What Is Mila

Mila is an AI-powered executive assistant for real estate agents in the Czech Republic. She monitors email and WhatsApp, understands conversations, proposes actions (reply, schedule meetings, follow up), and executes them on approval.

**Makléři nepřicházejí o obchody proto, že by nedělali svou práci. Přicházejí o ně proto, že nestíhají — nezodpovězený e-mail, zapomenutý follow-up, lead, který vychladl o týden dřív, než si toho někdo všiml. Mila tohle hlídá za vás, nepřetržitě, bez výjimky.**

Jedno uzavřené jednání navíc za rok. To je vše, co Mila potřebuje, aby se zaplatila — a ještě vám zbylo.

Průměrná provize z prodeje nemovitosti: **80 000 Kč**. Roční náklad na Milu: **50 000 Kč**. Čistý zisk z jednoho zachráněného obchodu: **30 000 Kč**.

Mila is not a chatbot. The user never "talks to" Mila. Instead, Mila watches all communication channels, detects what needs attention, prepares specific action proposals, and sends a daily morning brief email with one-click approve/edit buttons.

## Business Model

**Custom setup per client** — each user is configured during onboarding via `scripts/configure-user.ts`, which stores their identity, business context, AI persona, and lead management thresholds into the `users.settings` JSONB column.

**Deployment model:** Shared infrastructure — one Vercel deployment + one Supabase instance for all users. Data isolation is enforced via `user_id` filtering on all queries (service key bypasses RLS). See `SECURITY.md` for details.

## How It Works

### The Pipeline

Mila runs on a trigger — either a cron job (morning brief) or an API call (`/api/agent/run`). Each run executes this pipeline:

```
Step 0: Purge user-as-counterparty (data hygiene)
Step 1: Verify user + credentials
Steps 2 + 2.1 + 2.5 run IN PARALLEL (Promise.allSettled):
  Step 2: Ingest inbound emails from Gmail (batched ×5)
  Step 2.1: Ingest outbound emails from Gmail (batched ×5)
  Step 2.5: Sync calendar events from Google Calendar, detect invitations
Step 3: Get all unprocessed messages (email + WhatsApp)
Step 4: Thread messages into conversations (Gmail thread ID → embedding similarity → AI tiebreak)
Step 5: For each updated conversation → AI proposes one or more actions (e.g. REPLY + SCHEDULE + TODO from one email) (batched ×5)
Step 6: Lead tracking — scan ALL conversations for cooling/cold/dead leads (batched ×10)
```

Concurrency: The pipeline uses a **DB-level lock** (`user_agent_locks` table) to prevent duplicate runs across Vercel serverless instances. Lock auto-expires after 10 minutes for crash safety.

### Action Types

**User-facing actions** (surface in morning brief for approval):

| Type | What Mila Does |
|------|----------------|
| **REPLY** | Prepares a draft email/WhatsApp response. User clicks APPROVE or EDIT, then Mila sends. |
| **SCHEDULE** | Finds free calendar slots, blocks them in user's calendar, prepares email offering times to counterparty. |
| **TODO** | Something the user needs to do themselves (call lawyer, write proposal, plan photoshoot). Mila describes what needs doing — no draft. |

**Internal states** (not shown to user, no action needed):

| Type | What Mila Does |
|------|----------------|
| **WAIT** | Flags the conversation as "no action needed now" — Mila keeps watching. |
| **ARCHIVE** | Conversation is finished — no response needed, nothing to watch. |

### Draft Generation

Drafts are generated **on-demand**, not during proposal creation. When the pipeline proposes an action, it stores only:
- `intent_cs` — what Mila plans to do (in Czech)
- `rationale_cs` — why this action is needed
- `missing_info` — questions the user needs to answer before execution

When the user clicks EXECUTE, Mila generates the actual email/message draft using the full conversation context + intent + any user notes.

### Morning Brief

Every morning at 8 AM (configurable), Mila sends an email to the user with:
- AI-generated headline summarizing the day
- Today's calendar events
- Ranked list of pending action proposals, each with:
  - Counterparty name and role
  - Conversation topic
  - What Mila proposes to do (intent)
  - Priority score
  - One-click APPROVE and EDIT buttons (HMAC-signed links)

### Instant High-Priority Notifications

Actions with `urgency >= 9` trigger an immediate email notification — the same action card format as briefs, sent within 5 minutes of action creation. Polled every 5 minutes via QStash (`/api/cron/instant-notify`).

- If the user acts on the instant notification, the action is resolved before the next brief
- If the user ignores it, the action still appears in the next morning/afternoon brief as a reminder

## Channels

### Email (Gmail)

Primary channel. Mila reads inbound and outbound emails via Gmail API, processes them through the full pipeline, and sends responses via the same API.

### WhatsApp

Secondary channel. Architecture:
- **Daemon** (`scripts/whatsapp-daemon.ts`) — standalone Node.js process using `@whiskeysockets/baileys` (pure WebSocket, no Puppeteer). Runs separately from the Next.js app.
- **Multi-session**: manages one Baileys connection per user (~5-10 MB each, scales to 50-100 users per server)
- Auth state persisted per user in `./baileys_auth/<userId>/`
- Daemon listens for incoming messages → writes to Supabase `messages` table with `channel_id: 'whatsapp'`
- Daemon exposes HTTP API: `GET /sessions`, `GET /status/:userId`, `POST /sessions/:userId/connect`, `DELETE /sessions/:userId`, `POST /send { userId, to, body }`, `GET /health`
- **Sender** (`src/lib/whatsapp/sender.ts`) — Next.js client that talks to the daemon's HTTP API, routing by `userId`
- **Status endpoint** (`/api/whatsapp/status?userId=xxx`) — proxies per-user daemon status for the dashboard

WhatsApp messages flow through the same pipeline as email. The AI receives channel context and adjusts tone — shorter, more conversational for WhatsApp vs. formal for email.

## Lead Tracking

The core anti-churn mechanism. Runs as Step 6 of every pipeline execution.

### How It Works

1. Scans all conversations for the user
2. Calculates days since last activity for each conversation
3. Classifies lead status:
   - **Active** (< 2 days) — no intervention
   - **Cooling** (2-5 days) — gentle check-in needed
   - **Cold** (5-14 days) — urgent follow-up
   - **Dead** (14+ days) — last-chance contact, escalate
4. For cooling/cold/dead leads:
   - Skips if there's already a pending action for that conversation
   - Skips if max auto follow-ups (3) already sent
   - Applies `selectOfferMultiplier()` based on CP role (seller/buyer) and `kcLowValue`/`kcHighValue` from user settings
   - Creates a REPLY action proposal with boosted priority score
   - Writes follow-up intent in Czech

### Priority Boosting

Lead tracking actions get multiplied priority so they surface at the top of the morning brief:
- Cooling: 1.5x boost
- Cold: 2.5x boost
- Dead: 3.75x boost (2.5 * 1.5)
- High-value conversations (matching `highValueSignals` from client config): additional 1.5x

### Thresholds

Stored per-user in `users.settings` (see `ONBOARDING.md` > Lead Management):
```
cooling_threshold_days: 2
cold_threshold_days: 5
dead_threshold_days: 14
max_auto_follow_ups: 3
```

## Per-User Configuration

All per-user configuration is stored in the `users.settings` JSONB column and configured via `scripts/configure-user.ts`. See `ONBOARDING.md` for the full settings reference.

`src/config/client.ts` contains helper functions that read from `UserSettings`:
- `getAISystemPrompt(settings)` — assembles the system prompt from the user's business context, tone, and language settings
- `containsHighValueSignals(text, settings)` — checks message text against the user's high-value keywords (used in planning + lead tracking)
- `isPersonalEvent(title, settings)` — checks calendar event titles against personal keywords

The `clientConfig` object in that file is legacy and not consumed at runtime.

## Conversation Threading

Messages are assigned to conversations using a 3-tier strategy:

1. **Gmail thread ID** (exact match on `external_thread_id`)
2. **Embedding similarity** (cosine similarity against conversation embeddings for same counterparty)
   - >= 0.78: auto-join (no AI needed)
   - 0.55 - 0.78: AI tiebreak via `shouldJoinConversation()`
   - < 0.55: create new conversation
3. **WhatsApp**: threaded by phone number (`wa:+phone`)

Conversation summaries are rebuilt after N new messages. Each summary includes: current state, risks, next steps, key points — all in Czech.

## Calendar & Scheduling

### Core Flow — Batch Schedule Optimization
When the brief is being prepared, Mila pre-optimizes ALL unsent SCHEDULE actions as a batch:
1. Collects all pending, unsent SCHEDULE actions
2. Optimizes slot selection across all new meetings using these criteria (in priority order):
   - **CP availability** — stated or inferred from conversation
   - **User availability** — free slots in user's calendar (working hours, no conflicts)
   - **Travel optimization** — avoid crossing town twice; cluster geographically when possible while respecting criteria above
   - **Conflict resolution (last resort)** — prefer scheduling without moving existing events. Declining due to conflict is acceptable in most cases. But if new meeting has high priority AND CP can only meet at a specific conflicted time, suggest moving the conflicting event — even if high weight. User always has final call
3. Picks THE optimal slot for each meeting — one slot per meeting, not multiple options
4. Creates a tentative hold event for each chosen slot (prevents double-booking while user reviews)
5. Presents a single batch schedule card in the brief, grouped by day
6. Each sub-card: suggested time, CP name, location, deal value, reasoning for that slot
7. CTAs per sub-card (UDĚLAT / UPRAVIT / UDĚLÁM SÁM) plus batch "UDĚLAT VŠE"
8. Approved → hold becomes confirmed, invite sent to CP. Rejected/edited → hold cleared
9. Only touches penciled-in (unsent) meetings. Sent invites and confirmed events are fixed walls — never auto-moved (but Mila may suggest moving them if conflict resolution requires it)

### Slot Finding
- `findFreeSlots()` scans working hours for gaps between all calendar events (including holds)
- Respects user settings: working hours, working days, meeting buffer

### Travel Time
- >500m = always driving via Google Maps (road work factored in, short-term incidents ignored)
- ≤500m = 15min flat buffer (walking distance)
- Buffer for >500m: `max(travelMinutes + 10, 15min minimum)`. Creates travel buffer events linked via `parent_event_id`

### Hold Events
- One hold per meeting — the optimal slot Mila chose
- Prevents double-booking between brief generation and user action
- Short-lived: approved → confirmed. Rejected/edited → cleared. Not acted on → remains, next brief nudges

### Calendar Invitations
- Detected invitations always create a SCHEDULE action — human in the loop, no auto-accept
- Mila checks user's calendar and suggests accept/reject/propose new time

### Conflict Resolution
- Compares event scores (new vs existing). Higher score wins
- User-created events default weight = 100 (treated as immovable)
- Handles rare conflicts with confirmed events — separate from batch optimization

### Personal Calendar Events
- Personal events (matching `isPersonalEvent(title, settings)`) block time but do NOT generate action proposals

## Priority Scoring

**Formula:** `score = normVal + U + daysIgnored² + W`

Four independent terms:
1. `normVal = log_compress(dollarValue) × sellerMultiplier` — deal size (post-log multiplier)
2. `U` — urgency: AI-assessed starting pressure (1-10)
3. `daysIgnored²` — time pressure, escalates quadratically
4. `W` — weight/immovability: flat, never changes (1-10 or 100)

| Input | Scale | Source |
|-------|-------|--------|
| `dollarValue` | 0+ CZK | AI-assessed from conversation |
| `kcLowValue` | default 500000 | `settings.kc_low_value` — "small deal" anchor, maps to normalized score ~2 |
| `kcHighValue` | default 5000000 | `settings.kc_high_value` — "big deal" anchor, maps to normalized score ~13 |
| `sellerMultiplier` | default 1 | Applied AFTER log. User settings: `offer_multiplier_seller` (1.5) or `offer_multiplier_buyer` (1.0) based on CP role |
| `urgency` | 1-10 | AI-assessed |
| `daysIgnored` | 0+ | Days since last activity (squared: day 3 = 9, day 7 = 49) |
| `weight` | 1-10 or 100 | How movable: 1 = easy to reschedule, 10 = hard to move. 100 = absolutely immovable (court date, kids concert, airport pickup) |

`sellerMultiplier` and `urgency` fall back to 1 if 0/null to prevent score collapse. `kcLowValue` falls back to 500000, `kcHighValue` must be > kcLowValue.

## AI Architecture

### Model Configuration

7 pipeline stages, each with a 3-model fallback chain:

| Stage | Purpose |
|-------|---------|
| `preFilter` | Spam/junk detection (cheapest model) |
| `classify` | Email category + priority |
| `enrichment` | Per-message key info extraction |
| `threading` | Topic extraction, conversation joining |
| `analysis` | Conversation analysis (state, risks, next steps) |
| `planning` | Action proposal (type, rationale, intent) |
| `drafting` | Final draft generation, morning brief headline |

Current chain: `preFilter`/`classify` use `gemini-2.5-flash-lite` primary; all other stages use `gemini-2.5-flash`. Fallbacks currently repeat the same model (no cross-model redundancy).

**Runner** (`src/lib/ai/runner.ts`): `runAITask(stage, prompt)` auto-cascades on failure, logs which model succeeded.

**Embedding model:** `gemini-embedding-001` (768-dim, multilingual) — separate from chat, no fallback.

### Business Context Injection

Every AI prompt receives the user's business context via `getAISystemPrompt(settings)` (reads from `UserSettings` in DB). This includes:
- Who the user is and what they do
- Market and specialization
- Typical deal size range (used as AI reference for `dollarValue` estimation in configured currency)
- High-value signals to watch for (detected via `containsHighValueSignals`, flagged to AI in planning prompt)
- Tone instructions
- Channel context (email vs WhatsApp adjusts formality)

The planning stage (`proposeAction`) also asks the AI to classify `dealType` (sale/purchase/rental/lease/consultation/other) which is written to `conversation_threads.deal_type`.

### Mila Voice — Centralized Text Generation

All text Mila produces — both user-facing and CP-facing — is generated through `src/lib/ai/mila-voice.ts`. This is the single source of truth for Mila's voice and tone.

**Mila → User** (tone: `settings.ai_tone_user`):
- Scheduling intent (slot details, conflicts, location woven into AI's original intent_cs)
- Lead follow-up intent/rationale (cooling/cold/dead — AI-generated, not templates)
- Brief intro (greeting, subject line, headline — AI-generated per brief)
- Urgent notification intro (subject, header, body — AI-generated per notification)

**Mila → CP** (tone: `settings.ai_tone_cp`):
- Final draft (email subject + body, or WhatsApp message — on-demand at execution time)

**Urgency-aware tone:** All user-facing functions receive urgency level. Urgency 9-10 produces direct, bold text conveying time pressure. Urgency 1-3 is calm and routine. The AI adjusts naturally — no hardcoded tone switching.

**No hardcoded Czech in services:** planning.ts, morning-brief.ts, and lead-tracking.ts call mila-voice.ts for all user-visible text. They pass structured data (slot times, conflict info, lead status, action counts) and get back natural language in Mila's voice.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript 5.7 (strict mode) |
| Database | Supabase (PostgreSQL + pgvector) |
| CSS | Tailwind CSS 3 |
| AI | Google Generative AI (Gemini) via `@google/generative-ai` |
| Email | Gmail API via `googleapis` |
| Calendar | Google Calendar API via `googleapis` |
| Maps | Google Maps Distance Matrix API |
| WhatsApp | @whiskeysockets/baileys (multi-session daemon, no Puppeteer) |
| Deployment | Vercel + cron jobs |
| Monitoring | Sentry (client + server + edge) |
| Auth | Google OAuth (email ownership proves identity) |

## API Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/agent/run` | API Key | Run full pipeline for a user |
| `POST /api/ingest` | API Key | Manual email/calendar ingestion |
| `POST /api/ingest/bulk` | API Key | Bulk ingestion orchestrator (202 via QStash on Vercel, NDJSON locally) |
| `POST /api/ingest/bulk/worker` | Cron Secret | QStash worker — processes Phase 1–4 in chained 50-email batches |
| `GET /api/action/[id]` | Action Token | Get action details |
| `POST /api/action/[id]/execute` | Action Token | Execute approved action |
| `POST /api/action/[id]/draft` | Action Token | Generate draft on demand |
| `POST /api/action/[id]/todo` | Action Token | Convert to todo |
| `POST /api/action/[id]/blacklist` | Action Token | Blacklist counterparty |
| `GET /api/cron/morning-brief` | Cron Secret | Trigger morning briefs |
| `GET /api/cron/instant-notify` | Cron Secret | Poll for high-priority actions (score >79) and send instant notifications |
| `GET /api/auth/connect` | None | Start Google OAuth flow |
| `GET /api/auth/callback` | None | OAuth callback |
| `GET /api/health` | None | Health check |
| `GET /api/whatsapp/status` | API Key | WhatsApp daemon status |
| `GET /api/superadmin/stats` | Superadmin Key | System stats |
| `GET /api/trigger/ingest` | Trigger Token (HMAC) | Tracking pixel — triggers agent run on email open |
| `POST /api/gdpr/delete` | API Key | GDPR Art. 17 — cascade-delete all user data |
| `GET /api/gdpr/export` | API Key | GDPR Art. 15 — export all user data as JSON |

## Security

- **API Key** (`MILA_USER_API_KEY`) — protects agent/ingest endpoints
- **Cron Secret** (`CRON_SECRET`) — protects cron endpoints
- **Action Token** (HMAC-signed, time-limited) — protects action links in emails
- **Superadmin Key** — protects admin dashboard
- **RLS** — Supabase row-level security on all tables; API uses service key so MUST manually filter by `user_id`
- **OAuth tokens** — AES-256-GCM encrypted (dual-write: plaintext + encrypted columns, reads encrypted first)
- **GDPR** — data deletion, data export, audit logging, retention policy (see `SECURITY.md`)
- **Concurrency** — DB-level agent lock prevents duplicate pipeline runs across Vercel instances

## Database

PostgreSQL via Supabase with pgvector extension for embeddings.

### Core Tables

- `users` — client accounts with settings, OAuth tokens
- `cps` (counterparties) — contacts the client communicates with
- `channels` — communication channels (email, whatsapp)
- `conversation_threads` — grouped conversations with AI summaries + embeddings
- `messages` — individual messages across all channels
- `action_proposals` — Mila's proposed actions with priority scores
- `events` — calendar events synced from Google Calendar
- `emails` — outbound email send queue
- `todos` — task items with due dates
- `agent_errors` — error log for monitoring
- `audit_logs` — GDPR audit trail (user_id FK SET NULL — survives user deletion)
- `user_agent_locks` — DB-level per-user agent pipeline concurrency lock

## What's Not Built Yet

- **User-configurable tone UI** — `ai_tone_user` and `ai_tone_cp` exist in UserSettings but there's no UI to change them. mila-voice.ts is wired to use them; just needs a settings page
- **Multi-language support** — currently Czech only (hardcoded in prompts, configurable via `ai_language` in user settings)
- **WhatsApp group monitoring** — Baileys daemon skips group messages
- **OAuth token encryption cleanup** — dual-write is active (plaintext + encrypted); plaintext column can be dropped once all users have refreshed tokens at least once
