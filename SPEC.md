# SPEC.md — Mila Product Specification

## What Is Mila

Mila is an AI-powered executive assistant for small business owners and sales professionals. She monitors email and WhatsApp, understands conversations, proposes actions (reply, schedule meetings, follow up, delegate), and executes them on approval.

The core value proposition: **don't drop leads, don't miss meetings, don't let deals go cold.**

Mila is not a chatbot. The user never "talks to" Mila. Instead, Mila watches all communication channels, detects what needs attention, prepares specific action proposals, and sends a daily morning brief email with one-click approve/edit buttons.

## Business Model

**Custom setup per client** — each deployment is configured for one business owner. Setup involves sitting with the client, understanding their business, and editing `src/config/client.ts` with their identity, business context, AI persona, and lead management thresholds.

Each client gets their own Vercel deployment + Supabase project. There is no multi-tenant shared instance.

## How It Works

### The Pipeline

Mila runs on a trigger — either a cron job (morning brief) or an API call (`/api/agent/run`). Each run executes this pipeline:

```
Step 0: Purge user-as-counterparty (data hygiene)
Step 1: Verify user + credentials
Step 2: Ingest inbound + outbound emails from Gmail
Step 2.5: Sync calendar events from Google Calendar, detect invitations
Step 3: Get all unprocessed messages (email + WhatsApp)
Step 4: Thread messages into conversations (Gmail thread ID → embedding similarity → AI tiebreak)
Step 5: For each updated conversation → AI proposes an action (REPLY / SCHEDULE / WAIT / FILE)
Step 6: Lead tracking — scan ALL conversations for cooling/cold/dead leads, create follow-up actions
```

### Action Types

| Type | What Mila Does |
|------|----------------|
| **REPLY** | Prepares a draft email/WhatsApp response. User clicks APPROVE or EDIT, then Mila sends. |
| **SCHEDULE** | Finds free calendar slots, blocks them in user's calendar, prepares email offering times to counterparty. |
| **WAIT** | Flags the conversation as "no action needed now" with a reason. |
| **FILE** | Archives — conversation requires no response. |
| **TODO** | Creates a to-do item with optional due date. |
| **DELEGATE** | Forwards to a delegate (e.g., assistant) with context. |

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
   - Creates a REPLY action proposal with boosted priority score
   - Writes follow-up intent in Czech

### Priority Boosting

Lead tracking actions get multiplied priority so they surface at the top of the morning brief:
- Cooling: 1.5x boost
- Cold: 2.5x boost
- Dead: 3.75x boost (2.5 * 1.5)
- High-value conversations (matching `highValueSignals` from client config): additional 1.5x

### Thresholds

All configurable in `src/config/client.ts`:
```
coolingThresholdDays: 2
coldThresholdDays: 5
deadThresholdDays: 14
maxAutoFollowUps: 3
```

## Per-Client Configuration

`src/config/client.ts` is the single file customized during client setup. Contains:

| Section | What It Configures |
|---------|--------------------|
| `client` | Name, company, email, phone, WhatsApp number |
| `business` | Market, specialization, typical deal size, high-value signals, low-priority signals |
| `ai` | Assistant name, language, tone with user, tone with counterparties, email signature, full system context prompt |
| `leads` | Cooling/cold/dead thresholds, max auto follow-ups, priority boost multipliers |
| `whatsapp` | Enabled flag, session path, daemon port, blocked numbers, monitored groups |
| `calendar` | Business calendar ID, personal calendar ID, personal event keywords |
| `scoring` | Offer multipliers (seller/buyer), VIP multiplier, KC factor |

The `getAISystemPrompt()` function assembles the full context injected into every AI prompt — business description, market, deal range, tone instructions.

`containsHighValueSignals(text)` checks message text against the client's high-value keywords.

`isPersonalEvent(title)` checks calendar event titles against personal keywords (doctor, family, gym, etc.). Personal events block time but don't generate action proposals.

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

When Mila proposes a SCHEDULE action:

1. `findFreeSlots()` scans working hours for gaps between all calendar events
2. Respects user settings: working hours, working days, meeting buffer
3. `calculateTravelForSlot()` uses Google Maps Distance Matrix API for travel time between locations
4. Creates travel buffer events linked via `parent_event_id`
5. Blocks proposed slots in user's calendar as tentative holds
6. On approval, Mila sends email to counterparty offering the time slots

### Conflict Resolution

When a new meeting conflicts with existing events:
- Compares event scores (new vs existing)
- Higher score wins: either move existing event or suggest alternate time
- User-created events default weight = 100 (treated as immovable)

## Priority Scoring

**Formula:** `(dollarValue * offerMultiplier * urgency) + (painFactor * (daysIgnored + 1)^2) + weight`

| Input | Scale | Source |
|-------|-------|--------|
| `dollarValue` | 0+ CZK | AI-assessed from conversation |
| `offerMultiplier` | default 1 | Client config: seller (1.5) or buyer (1.0) |
| `urgency` | 1-10 | AI-assessed |
| `painFactor` | 1-10 | AI-assessed relationship pain |
| `daysIgnored` | 0+ | Days since last activity (squared growth) |
| `weight` | 0-100 | How immovable (100 = flight, concert) |

All multipliers fall back to 1 if 0/null to prevent score collapse.

## AI Architecture

### Model Configuration

6 pipeline stages, each with a 3-model fallback chain:

| Stage | Purpose |
|-------|---------|
| `preFilter` | Spam/junk detection (cheapest model) |
| `classify` | Email category + priority |
| `threading` | Topic extraction, conversation joining |
| `analysis` | Conversation analysis (state, risks, next steps) |
| `planning` | Action proposal (type, rationale, intent) |
| `drafting` | Final draft generation, morning brief headline |

Current chain: `gemini-2.5-flash` -> `gemini-2.0-flash` -> `gemini-1.5-flash` for all stages.

**Runner** (`src/lib/ai/runner.ts`): `runAITask(stage, prompt)` auto-cascades on failure, logs which model succeeded.

**Embedding model:** `gemini-embedding-001` (768-dim, multilingual) — separate from chat, no fallback.

### Business Context Injection

Every AI prompt receives the client's business context via `getAISystemPrompt()` from client config. This includes:
- Who the client is and what they do
- Market and specialization
- Typical deal size range
- High-value signals to watch for
- Tone instructions
- Channel context (email vs WhatsApp adjusts formality)

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
| `POST /api/ingest/bulk` | API Key | Bulk message ingestion |
| `GET /api/action/[id]` | Action Token | Get action details |
| `POST /api/action/[id]/execute` | Action Token | Execute approved action |
| `POST /api/action/[id]/draft` | Action Token | Generate draft on demand |
| `POST /api/action/[id]/todo` | Action Token | Convert to todo |
| `POST /api/action/[id]/blacklist` | Action Token | Blacklist counterparty |
| `GET /api/cron/morning-brief` | Cron Secret | Trigger morning briefs |
| `GET /api/auth/connect` | None | Start Google OAuth flow |
| `GET /api/auth/callback` | None | OAuth callback |
| `GET /api/health` | None | Health check |
| `GET /api/whatsapp/status` | None | WhatsApp daemon status |
| `GET /api/superadmin/stats` | Superadmin Key | System stats |

## Security

- **API Key** (`MILA_USER_API_KEY`) — protects agent/ingest endpoints
- **Cron Secret** (`CRON_SECRET`) — protects cron endpoints
- **Action Token** (HMAC-signed, time-limited) — protects action links in emails
- **Superadmin Key** — protects admin dashboard
- **RLS** — Supabase row-level security on all tables; API uses service key so MUST manually filter by `user_id`
- **OAuth tokens** — migrating from plaintext JSONB to encrypted storage

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

## What's Not Built Yet

- **Multi-language support** — currently Czech only (hardcoded in prompts)
- **WhatsApp group monitoring** — Baileys daemon skips group messages (TODO in code)
- **Offer multiplier wiring** — `planning.ts` doesn't yet pass `offerMultiplier` from client config to `calculatePriorityScore()`
- **Weight in proposals** — `weight` field not set during proposal generation
- **Email encryption** — OAuth tokens migration from plaintext to encrypted is in progress
- **User settings → AI tone wiring** — `ai_tone_user` / `ai_tone_cp` in user settings DB are NOT used; client config's `ai.toneWithUser` / `ai.toneWithCounterparties` are used instead
- **Test framework** — no tests configured; `npm run build` is the verification method
