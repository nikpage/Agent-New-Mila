# Conversation Agent — Extraction Spec

Unified cross-channel conversation tracker for a single user with multiple accounts.

## What This Is

One person. Multiple email accounts, chat apps, phone numbers. All conversations unified into one interface. Cross-channel tracking (email thread continues on WhatsApp = same conversation). Reply from the UI → goes out on the correct channel and account.

## What It Is NOT

- Not a draft generator or AI writer
- Not a priority/urgency system
- Not a scheduling/calendar optimizer
- Not a lead tracker
- Not a brief/notification sender
- Not multi-tenant (single user, multiple accounts)

---

## Data Model

### New: `user_accounts`

Every connected account the user owns. Each is one "ear" for incoming messages.

```sql
CREATE TABLE user_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  account_type TEXT NOT NULL,          -- 'gmail', 'outlook', 'whatsapp', 'telegram', ...
  label TEXT,                          -- user-assigned: 'Work', 'Personal', etc. AI guesses on creation, user corrects
  identifier TEXT NOT NULL,            -- 'work@gmail.com', '+420777123456', '@telegram_handle'
  credentials_encrypted TEXT,          -- encrypted OAuth tokens / API keys
  sync_cursor TEXT,                    -- gmail_history_id, last_message_id, etc. (per-account)
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, account_type, identifier)
);
```

### Reused from Mila (renamed)

| Mila table | New name | Changes |
|---|---|---|
| `cps` | `contacts` | Drop `deal_type`, `offer_multiplier`. Add `merged_into_id` (self-FK for contact merging) |
| `conversation_threads` | `conversations` | Drop `deal_type`, `snooze_until`, `dollar_value`. Keep `status`, `topic`, `summary`, `embedding` |
| `messages` | `messages` | Add `source_account_id` (FK → user_accounts). Keep `channel_id`, `direction`, `conversation_id` |
| `deal_timeline` | `timeline` | Same structure, drop name. Add `source_account_id` |
| `channels` | `channels` | Unchanged — maps channel UUIDs to types |
| `message_embeddings` | `message_embeddings` | Unchanged |
| `thread_participants` | `conversation_participants` | Unchanged |

### New: `contact_identifiers`

Supports multiple identifiers per contact (for merge tracking).

```sql
CREATE TABLE contact_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id),
  identifier_type TEXT NOT NULL,       -- 'email', 'phone', 'whatsapp', 'telegram'
  identifier_value TEXT NOT NULL,      -- normalized value
  source TEXT,                         -- 'auto' (exact match), 'user_confirmed', 'ai_suggested'
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(identifier_type, identifier_value)
);
```

### New: `merge_suggestions`

Queue of AI-suggested merges awaiting user decision.

```sql
CREATE TABLE merge_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  suggestion_type TEXT NOT NULL,       -- 'contact' or 'conversation'
  entity_a_id UUID NOT NULL,           -- contact or conversation ID
  entity_b_id UUID NOT NULL,           -- contact or conversation ID
  confidence REAL,                     -- AI confidence 0.0-1.0
  reasoning TEXT,                      -- AI explanation shown to user
  status TEXT DEFAULT 'pending',       -- 'pending', 'accepted', 'rejected'
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Dropped from Mila entirely

- `action_proposals` — no action system
- `todos` — no task management
- `events` — no calendar optimization (keep if calendar sync is added)
- `emails` — Mila-specific email metadata
- `audit_logs` — GDPR multi-tenant, not needed for single user
- `user_agent_locks` — single user, no concurrency concern

---

## Modules: Keep, Strip, Drop

### Keep as-is (~1,750 lines)

| File | Lines | Notes |
|---|---|---|
| `src/lib/db/channels.ts` | 100 | 100% generic |
| `src/lib/embeddings/generate.ts` | 222 | 100% generic, channel-aware cleaning |
| `src/lib/db/timeline.ts` | 362 | Rename table references deal_timeline → timeline |
| `src/lib/db/conversations.ts` | ~300 | CRUD, rename table |
| `src/lib/db/messages.ts` | ~250 | CRUD, add source_account_id |
| `src/lib/ai/runner.ts` | ~150 | AI fallback chain — reusable |
| `src/lib/ai/providers/*` | ~300 | Gemini + Anthropic providers |
| `src/lib/crypto.ts` | 81 | Token encryption — needed for multi-account credentials |

### Strip and keep (~1,100 lines → ~700 lines after stripping)

| File | Lines | Strip | Keep |
|---|---|---|---|
| `src/services/threading.ts` | 684 | Todo creation, deal_type classification, journal lookups (~150 lines) | Core algorithm: external thread ID → CP count → density heuristic → AI (~530 lines) |
| `src/services/ingestion.ts` | 521 | Command handling, action-related logic (~120 lines) | Email fetch → clean → enrich → embed → store (~400 lines) |
| `src/services/calendar-ingestion.ts` | 384 | Action proposals, weight/todo creation (~150 lines) | Calendar sync, event dedup, attendee parsing (~230 lines) |
| `src/lib/ai/gemini.ts` | 660 | proposeAction, real-estate prompts (~350 lines) | extractTopic, shouldJoinConversation, classifyEmail, enrichMessage (rewrite prompts), analyzeConversation (rewrite prompts) (~310 lines) |

### Drop entirely

| File/directory | Reason |
|---|---|
| `src/services/planning.ts` | Action proposals — not needed |
| `src/services/lead-tracking.ts` | Lead detection — not needed |
| `src/services/morning-brief.ts` | Brief emails — not needed |
| `src/services/scheduling.ts` | Calendar optimization — not needed |
| `src/services/reflection.ts` | Journal — v2 at best |
| `src/services/backfill-report.ts` | Mila onboarding — not needed |
| `src/services/bulk-ingestion.ts` | Historical backfill — rebuild if needed |
| `src/lib/ai/mila-voice.ts` | Draft generation — not needed |
| `src/lib/db/actions.ts` | Action CRUD — not needed |
| `src/lib/db/todos.ts` | Todo CRUD — not needed |
| `src/lib/db/gdpr.ts` | Multi-tenant GDPR — not needed |
| `src/lib/db/locks.ts` | Agent concurrency — not needed (single user) |
| `src/lib/db/journal.ts` | Journal — not needed |
| `src/lib/qstash/*` | Brief scheduling — not needed |
| `src/shared/scoring.ts` | Priority formula — not needed |
| `src/shared/deal-types.ts` | Deal classification — not needed |
| `src/config/client.ts` | Per-client config — rethink for single user |
| `src/components/action/*` | Action card UI — not needed |
| `src/components/brief/*` | Brief UI — not needed |
| `src/app/api/cron/*` | Cron endpoints — not needed |
| `src/app/api/agent/*` | Agent pipeline — rebuild as simpler ingestion loop |
| `src/app/api/action/*` | Action API — not needed |
| `src/app/api/backfill/*` | Backfill — not needed |
| `src/app/api/superadmin/*` | Superadmin — not needed |

---

## User Decisions (UI surfaces needed)

Only 4 types of decisions ever surface to the user:

### 1. Contact merge suggestion
**Trigger:** New message arrives, fuzzy match on name/signature/company domain against existing contact.
**UI:** Inline card: "Is [new identifier] the same person as [existing contact]?" → Yes / No
**Reversible:** Always. Undo merge available from contact detail view.

### 2. Conversation merge suggestion
**Trigger:** Same contact, similar topic, different channel. AI confidence below auto-merge threshold.
**UI:** Inline card showing both conversation snippets: "Same conversation?" → Yes / No
**Reversible:** Always. Undo merge splits conversations back.

### 3. Reply channel/account selection
**Trigger:** User composes reply from merged conversation view.
**Default:** AI picks based on: (a) direct reply = same channel/account, (b) message nature — long/attachments → email, short → chat, (c) account label context, (d) last-used channel with this contact.
**UI:** Dropdown override before send. User sees the AI pick, can change it.
**Reversible:** N/A — choice made before send.

### 4. Account labeling
**Trigger:** New account connected via OAuth.
**Default:** AI guesses label from email address / account name (work@company.com → "Work").
**UI:** Editable label field.
**Reversible:** Always editable.

---

## Reply Routing

When user hits reply:

1. **From a specific message** → reply via same account + channel + thread. No ambiguity.
2. **From conversation view** (merged, multi-channel) → AI picks:
   - Long message / has attachment → email (primary email account, or last-used email with this contact)
   - Short message → most-used chat channel with this contact
   - Account tag context: work-related conversation → work account
   - User overrides via dropdown before sending
3. **Message sent** → tagged with `source_account_id`, delivered via that account's credentials, threaded correctly (In-Reply-To header for email, reply-to-message-id for WhatsApp, etc.)

---

## Ingestion Loop

Replaces Mila's 8-step agent pipeline with a simpler loop:

```
For each user_account where active = true:
  1. Fetch new messages since sync_cursor
  2. For each message:
     a. Clean text (channel-aware)
     b. Deduplicate (external_message_id)
     c. Resolve contact (exact match → auto, fuzzy → suggest merge)
     d. Enrich (AI: extract parties, topic, key info)
     e. Generate embedding
     f. Write to messages + timeline
     g. Assign to conversation (threading algorithm)
     h. Update conversation summary if needed
  3. Update sync_cursor
```

Runs on a poll interval (configurable, default 2 min for email, real-time for WhatsApp/Telegram via webhooks).

---

## UI Pages (minimal v1)

### Inbox / Conversation List
- All conversations, sorted by last activity
- Each shows: contact name, topic/summary snippet, last message preview, channel icons, unread indicator
- Filter by: account, channel type, contact

### Conversation Detail
- Full message history, chronological
- Messages show: channel icon, account label, timestamp, original formatting
- "View original" link/expand for each message (shows raw email, original WhatsApp, etc.)
- Reply compose box at bottom with channel/account picker

### Contacts
- Contact list with all known identifiers
- Merge suggestions badge
- Contact detail: all identifiers, all conversations, merge history

### Accounts
- Connected accounts with label, type, sync status
- Connect new account (OAuth flow)
- Edit label, disconnect

### Calendar (if included)
- Unified view across all connected calendar accounts
- Events show which calendar they're from

---

## Phase Plan

### Phase 1: Strip & Skeleton (3 days)
- Fork cleanup: delete all dropped modules listed above
- Rename tables in DB layer code
- Create `user_accounts` table + migration
- Verify build passes with stripped codebase
- Basic ingestion loop running for 1 Gmail account

### Phase 2: Multi-Account + Contact Merge (5 days)
- OAuth flow for connecting additional accounts
- `contact_identifiers` table
- Exact-match auto-merge on email/phone
- Fuzzy match → `merge_suggestions` table
- AI confidence scoring for merge suggestions

### Phase 3: Threading Across Channels (5 days)
- Transplant stripped threading.ts
- Cross-channel conversation assignment (email + WhatsApp about same topic → one conversation)
- Conversation merge suggestions for ambiguous cases
- Conversation summary rebuilds

### Phase 4: Inbox UI (7 days)
- Conversation list page
- Conversation detail with multi-channel message display
- "View original" per message
- Contact list + merge suggestion UI

### Phase 5: Reply Routing (5 days)
- Compose UI with channel/account picker
- AI-based default channel selection
- Send via correct account credentials
- Thread correctly per channel (In-Reply-To for email, reply chains for chat)

### Phase 6: Calendar + Polish (5 days)
- Multi-calendar sync
- Unified calendar view
- Account label editing
- Undo merge for contacts and conversations

---

## Mila Modules → Conversation Agent Mapping

For reference when transplanting code:

| Mila file | → Conversation Agent | Action |
|---|---|---|
| `src/services/agent.ts` | `src/services/ingestion-loop.ts` | Rewrite: simplified loop, no action/planning steps |
| `src/services/threading.ts` | `src/services/threading.ts` | Strip: remove deal_type, todos, journal |
| `src/services/ingestion.ts` | `src/services/email-ingestion.ts` | Strip: remove commands, action logic |
| `src/services/calendar-ingestion.ts` | `src/services/calendar-sync.ts` | Strip: remove actions, todos, weight |
| `src/lib/db/timeline.ts` | `src/lib/db/timeline.ts` | Rename table references |
| `src/lib/db/counterparties.ts` | `src/lib/db/contacts.ts` | Rename, add merge support |
| `src/lib/db/conversations.ts` | `src/lib/db/conversations.ts` | Drop deal_type column refs |
| `src/lib/db/messages.ts` | `src/lib/db/messages.ts` | Add source_account_id |
| `src/lib/db/channels.ts` | `src/lib/db/channels.ts` | Unchanged |
| `src/lib/embeddings/generate.ts` | `src/lib/embeddings/generate.ts` | Unchanged |
| `src/lib/ai/gemini.ts` | `src/lib/ai/gemini.ts` | Drop proposeAction, rewrite enrichMessage + analyzeConversation prompts |
| `src/lib/ai/runner.ts` | `src/lib/ai/runner.ts` | Unchanged |
| `src/lib/ai/providers/*` | `src/lib/ai/providers/*` | Unchanged |
| `src/lib/google/gmail.ts` | `src/lib/google/gmail.ts` | Unchanged |
| `src/lib/google/calendar.ts` | `src/lib/google/calendar.ts` | Unchanged |
| `src/lib/google/auth.ts` | `src/lib/google/auth.ts` | Extend for multi-account |
| `src/lib/whatsapp/*` | `src/lib/whatsapp/*` | Unchanged |
| `src/lib/crypto.ts` | `src/lib/crypto.ts` | Unchanged |
