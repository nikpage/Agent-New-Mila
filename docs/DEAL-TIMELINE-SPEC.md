# Unified Deal Timeline — Technical Specification

**Status**: Draft — pending human review
**Date**: 2026-03-28
**Scope**: New architectural layer for chronological deal event tracking

---

## 1. Migration SQL

### 1.1 New table: `deal_timeline`

```sql
-- Event type: text column (not Postgres ENUM — easier to extend)
-- Valid values: 'email', 'whatsapp', 'call_log', 'voice_note'

-- Direction: text column
-- Valid values: 'in', 'out', 'internal'

CREATE TABLE deal_timeline (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cp_id uuid NOT NULL REFERENCES cps(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversation_threads(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES deal_timeline(id) ON DELETE SET NULL,
  event_type text NOT NULL,          -- 'email', 'whatsapp', 'call_log', 'voice_note'
  direction text NOT NULL,           -- 'in', 'out', 'internal'
  occurred_at timestamptz NOT NULL,  -- when it actually happened (sort key)
  ingested_at timestamptz NOT NULL DEFAULT now(),
  content text,                      -- cleaned text, note, or transcription
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  metadata jsonb DEFAULT '{}'::jsonb
);

-- Primary query: "all timeline events for a CP, sorted by when they happened"
CREATE INDEX idx_timeline_user_cp_occurred
  ON deal_timeline (user_id, cp_id, occurred_at DESC);

-- Conversation assignment writeback: find unassigned entries
CREATE INDEX idx_timeline_unassigned
  ON deal_timeline (user_id, cp_id)
  WHERE conversation_id IS NULL;

-- Parent lookup (voice notes → call logs)
CREATE INDEX idx_timeline_parent
  ON deal_timeline (parent_id)
  WHERE parent_id IS NOT NULL;

-- Message dedup: prevent double-inserting the same message
CREATE UNIQUE INDEX idx_timeline_message_id
  ON deal_timeline (message_id)
  WHERE message_id IS NOT NULL;

-- RLS policy (same pattern as all other tables)
ALTER TABLE deal_timeline ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own timeline"
  ON deal_timeline FOR ALL
  USING (user_id = auth.uid());
```

**Design decisions:**
- `event_type` is `text`, not a Postgres ENUM. Adding new event types (e.g. `meeting_note`, `document_signed`) doesn't require a migration.
- `cp_id` is NOT NULL. Every timeline entry must be associated with a CP. If CP resolution fails, the entry is not created — hard requirement.
- `message_id` has a unique partial index. An email or WhatsApp message can appear at most once in the timeline. Call logs and voice notes have `message_id = NULL`.
- `conversation_id` is nullable at insert, written back after assignment. SET NULL on delete so orphaned timeline entries don't break.

### 1.2 Changes to existing tables

#### `messages` table

**`occurred_at` column**: Already exists (`string | null` in types.ts). Already populated by `ingestion.ts` — set to `email.date.toISOString()` for both inbound and outbound emails. The handoff document says "currently unused" but this is incorrect: it IS populated on every email ingestion. However, nothing queries by `occurred_at` — all queries use `timestamp`.

**Action needed**: No structural change. The `deal_timeline.occurred_at` is populated independently (from the same source: `email.date` for emails, call start time for calls). No migration needed.

#### `conversation_threads` table

Already works for multi-channel conversations — a conversation can contain both email and WhatsApp messages via different `channel_id` values on messages. No structural changes needed.

The conversation assignment algorithm changes significantly (see Section 3), but the table itself is untouched.

#### `cps` table

**`role` column**: Already exists as `text | null`. No schema change needed. The behavioral distinction (deal CP vs service CP) is code-level, not schema-level. See Section 4.

**CP role categories** (three tiers):

| Tier | Roles | Pipeline behavior |
|------|-------|-------------------|
| RetailDeal | `buyer`, `seller`, `small-landlord`, `renter` | Full pipeline: timeline, assignment, lead tracking, actions |
| BusinessDeal | `investor`, `big-landlord` | Full pipeline. Multiple concurrent conversations expected (serial deals) |
| Service | `lawyer`, `notary`, `photographer`, `appraiser`, `inspector`, `repair-builder` | Timeline + assignment + actions. No lead tracking |

AI assigns roles. User has approval and edit capability (CP management UI — separate future work, data model supports it now via `updateCP`).

**Type changes**: Replace `VALID_CP_ROLES` in `types.ts`:
```typescript
export const VALID_CP_ROLES = [
  // RetailDeal
  'buyer', 'seller', 'small-landlord', 'renter',
  // BusinessDeal
  'investor', 'big-landlord',
  // Service
  'lawyer', 'notary', 'photographer', 'appraiser', 'inspector', 'repair-builder',
  // Legacy/catch-all
  'other',
] as const
```

Remove the old values that don't map cleanly (`landlord` → split into `small-landlord`/`big-landlord`, `tenant` → `renter`, `agent` → removed — agents are represented by their actual role, `developer` → `investor` or `repair-builder` depending on context). Migration: existing `role` values that don't match new enum are set to `null` for AI re-classification.

#### `message_type` on `messages`

Text column, not a Postgres ENUM. Call logs and voice notes do NOT go into `messages` — they go into `deal_timeline` only. No migration needed.

### 1.3 TypeScript type changes

```typescript
// In src/lib/supabase/types.ts — add to Database['public']['Tables']

deal_timeline: {
  Row: {
    id: string
    user_id: string
    cp_id: string
    conversation_id: string | null
    parent_id: string | null
    event_type: string       // 'email' | 'whatsapp' | 'call_log' | 'voice_note'
    direction: string        // 'in' | 'out' | 'internal'
    occurred_at: string
    ingested_at: string
    content: string | null
    message_id: string | null
    metadata: Json | null
  }
  Insert: {
    id?: string
    user_id: string
    cp_id: string
    conversation_id?: string | null
    parent_id?: string | null
    event_type: string
    direction: string
    occurred_at: string
    ingested_at?: string
    content?: string | null
    message_id?: string | null
    metadata?: Json | null
  }
  Update: {
    id?: string
    user_id?: string
    cp_id?: string
    conversation_id?: string | null
    parent_id?: string | null
    event_type?: string
    direction?: string
    occurred_at?: string
    ingested_at?: string
    content?: string | null
    message_id?: string | null
    metadata?: Json | null
  }
}
```

Add export types:
```typescript
export type DealTimelineEntry = Database['public']['Tables']['deal_timeline']['Row']
export type DealTimelineInsert = Database['public']['Tables']['deal_timeline']['Insert']

// CP role tier helpers
export const RETAIL_DEAL_ROLES = ['buyer', 'seller', 'small-landlord', 'renter'] as const
export const BUSINESS_DEAL_ROLES = ['investor', 'big-landlord'] as const
export const SERVICE_ROLES = ['lawyer', 'notary', 'photographer', 'appraiser', 'inspector', 'repair-builder'] as const
export const DEAL_ROLES = [...RETAIL_DEAL_ROLES, ...BUSINESS_DEAL_ROLES] as const
```

---

## 2. Updated Agent Pipeline

### 2.1 Current pipeline (from `agent.ts`)

```
Step 1:   Verify user + credentials
Step 0:   purgeUserAsCp
Steps 2/2.1/2.5 PARALLEL:
  Step 2:   Ingest inbound emails (clean → enrich → embed)
  Step 2.1: Ingest outbound emails (clean → enrich → embed)
  Step 2.5: Sync Google Calendar events
Step 3:   Get unprocessed messages (conversation_id IS NULL)
Step 4:   Thread messages into conversations
Step 4.5: Force-rebuild conversation summaries
Step 5:   Generate action proposals
Step 6:   Lead tracking
```

### 2.2 New pipeline step order

```
Step 1:   Verify user + credentials                     (unchanged)
Step 0:   purgeUserAsCp                                  (unchanged)
Steps 2/2.1/2.5 PARALLEL:
  Step 2:   Ingest inbound emails                        (CHANGED — also writes to deal_timeline)
  Step 2.1: Ingest outbound emails                       (CHANGED — also writes to deal_timeline)
  Step 2.5: Sync Google Calendar events                  (unchanged for now)
Step 2.7:  Ingest call logs from mobile app              (NEW — reads from deal_timeline, already inserted by call log API)
Step 3:    Get unassigned timeline entries                (CHANGED — queries deal_timeline WHERE conversation_id IS NULL)
Step 4:    Assign timeline entries to conversations       (CHANGED — new algorithm, see Section 3)
Step 4.5:  Force-rebuild conversation summaries           (CHANGED — uses timeline context, not just messages)
Step 5:    Generate action proposals                      (CHANGED — context from timeline)
Step 6:    Lead tracking                                  (CHANGED — uses timeline for activity detection, skips service CPs)
```

### 2.3 Detailed changes per step

**Step 2/2.1 — Email ingestion**: After creating the message record in `messages`, also insert into `deal_timeline`:
```
deal_timeline.insert({
  user_id,
  cp_id: cp.id,              // already resolved by ingestion
  event_type: 'email',
  direction: 'inbound' | 'outbound',
  occurred_at: email.date,
  content: cleanedText,       // same as messages.cleaned_text
  message_id: messageId,      // FK back to messages table
})
```
This happens inside `processOneInboundEmail()` and `processOneOutboundEmail()` in `ingestion.ts`, after `createMessage()` succeeds. The `conversation_id` is left NULL — written back in Step 4.

**Step 2.7 — Call log ingestion**: Call logs are written to `deal_timeline` by the call log app's API endpoint (see Section 7). Step 2.7 doesn't fetch from an external source — it acknowledges that new timeline entries may exist from the call log app. These entries already have `cp_id` set and `conversation_id = NULL`.

**Step 3 — Get unassigned entries**: Replace `getUnprocessedMessages(userId)` with:
```typescript
async function getUnassignedTimelineEntries(userId: string): Promise<DealTimelineEntry[]> {
  return supabase
    .from('deal_timeline')
    .select('*')
    .eq('user_id', userId)
    .is('conversation_id', null)
    .order('occurred_at', { ascending: true })
    .limit(100)
}
```

**CRITICAL**: WhatsApp messages must also write to `deal_timeline` at ingestion time. The daemon creates a message record, then inserts a timeline entry — same pattern as email.

**Step 4 — Conversation assignment**: See Section 3.

**Step 4.5 — Summary rebuild**: Currently uses `getRecentMessages(conversation.id, 20)` from `messages`. Change to pull from `deal_timeline` for the same conversation — this brings in call logs and voice notes that have no `messages` row. The summary AI receives richer context.

**Step 5 — Action proposals**: `generateActionProposal()` in `planning.ts` currently reads `getRecentMessages(conversation.id, 10)`. Change to read recent timeline entries for the conversation. The AI sees "called CP for 3 minutes, then got an email about the contract" as a coherent sequence. The timeline is also used for draft writing — Mila sees the full deal arc.

**Step 6 — Lead tracking**: `getLatestMessageFromCP()` currently queries `messages` WHERE `direction = 'inbound'`. Change to query `deal_timeline` WHERE `direction = 'in'` AND `cp_id = cpId`. A phone call from a CP resets the "days since activity" counter. Skip conversations where the CP has a service role (see Section 4).

---

## 3. Conversation Assignment Algorithm

### 3.1 Current flow (threading.ts)

```
1. External thread ID match (Gmail thread ID) → auto-join
2. Embedding similarity (same CP only, ≥0.78 auto-join, 0.55-0.78 AI tiebreak)
3. Create new conversation
```

### 3.2 New flow

Replaces Step 2 (embedding similarity) with timeline-based heuristic + AI. Keeps Step 1 (external thread ID) as fast path.

For each unassigned timeline entry:

**Step 1 — External thread ID match (fast path)**
If the entry has a linked `message_id`, and that message has `external_thread_id`, use `findConversationByExternalThread()`. If found, assign immediately. This is the same-channel email fast path — works within Gmail threads. Does NOT help cross-channel (WhatsApp, calls).

**Step 2 — CP resolution**
Already done at ingestion time — `cp_id` is always set on timeline entries.

**Step 3 — Count active conversations for this CP**
```sql
SELECT DISTINCT ct.id, ct.topic, ct.last_updated
FROM conversation_threads ct
JOIN thread_participants tp ON tp.thread_id = ct.id
WHERE ct.user_id = :userId
  AND ct.state = 'active'
  AND tp.cp_id = :cpId
ORDER BY ct.last_updated DESC
```

- **Zero** conversations → create new (skip to Step 6).
- **One** conversation → assign immediately (skip to Step 5). This is the common case for RetailDeal CPs.
- **Multiple** conversations → proceed to Step 4.

**Step 4 — Density/recency heuristic**
For each active conversation with this CP, count recent timeline entries:
```sql
SELECT conversation_id, COUNT(*) as recent_count
FROM deal_timeline
WHERE user_id = :userId
  AND cp_id = :cpId
  AND conversation_id IN (:candidateConversationIds)
  AND occurred_at > now() - interval '15 minutes'
GROUP BY conversation_id
ORDER BY recent_count DESC
```

If top candidate has >= 3 entries in last 15 minutes and next best has 0, auto-assign without AI.

Otherwise → Step 4b.

**Step 4b — AI assignment**
Feed recent timeline items from each candidate conversation plus the new entry:

```
NEW EVENT:
[event_type] [direction] [occurred_at]: [content preview]

CANDIDATE CONVERSATIONS:
--- Conversation A: "[topic]" ---
[recent timeline entries for this conversation]

--- Conversation B: "[topic]" ---
[recent timeline entries for this conversation]

Which conversation does this new event belong to? Or is it a NEW conversation?
Respond with the conversation ID or "NEW".
```

**Context window**: Up to 10 recent timeline entries per candidate conversation (`TIMELINE_CONTEXT_WINDOW = 10`). Uses whatever exists — if a conversation has 2 entries, use 2. If 0 entries (freshly created), use just the topic. Many messages will be very short ("ano", "ne", "ok") — this is fine, the AI still sees them as sequence context. The window is a max, not a minimum.

**Stage**: `threading` (gemini-2.5-flash → claude-sonnet).

**Step 5 — Write back**
Once assigned, write `conversation_id` back to:
1. The `deal_timeline` entry
2. The linked `messages` row (if `message_id` is not null)

Also: `incrementMessageCount()` and `addParticipant()` as current pipeline does.

**Step 6 — New conversation creation**
Triggers when:
- Zero active conversations exist for this CP (Step 3) — always create.
- AI in Step 4b says "NEW" — create. This handles the case where a CP returns after a deal is done (e.g., buyer purchases a second property). The AI sees the old conversation is about Property A and the new message is about Property B.
- If the AI is uncertain, it can respond "ASK" — Mila creates a TODO asking the user which conversation this belongs to, and holds the timeline entry unassigned until the next pipeline run.

### 3.3 Backward compatibility

`messages.conversation_id` continues to be populated via writeback in Step 5. All existing queries that join on `messages.conversation_id` continue to work. The `deal_timeline` is the source of truth for assignment, but `messages` stays in sync.

`getUnprocessedMessages()` remains as a fallback/migration helper but is no longer the primary pipeline driver.

---

## 4. CP Role Pipeline Rules

### 4.1 Role categories

| Tier | Roles | Lead tracking | Actions | Multiple concurrent conversations |
|------|-------|--------------|---------|----------------------------------|
| RetailDeal | `buyer`, `seller`, `small-landlord`, `renter` | Yes (full) | Yes | Rare (one deal at a time) |
| BusinessDeal | `investor`, `big-landlord` | Yes (full) | Yes | Common (serial/parallel deals) |
| Service | `lawyer`, `notary`, `photographer`, `appraiser`, `inspector`, `repair-builder` | No (skip) | Yes | Common (involved in multiple deals) |
| Unclassified | `null`, `other` | Yes (treated as RetailDeal) | Yes | Assumed rare |

### 4.2 Role assignment

AI assigns during enrichment. The enrichment prompt (`enrichMessage` in `gemini.ts`) gets an additional extraction instruction: classify the counterparty's role from the message content and signature. Output added to enriched text as `Role: [role]`.

User approves/edits via future CP management UI. The `updateCP` function already supports role updates — UI is out of scope for this spec but the data model is ready.

### 4.3 Service CP pipeline behavior

**Timeline**: Written normally. Every interaction recorded.

**Conversation assignment**: Runs normally. Service CPs in multiple deals get proper multi-conversation assignment via the density/AI algorithm.

**Lead tracking**: Skipped entirely.
```typescript
// In processConversationForLeadTracking():
const isServiceCP = cp.role && SERVICE_ROLES.includes(cp.role)
if (isServiceCP) return
```

**Action proposals**: Run normally. Urgency assessed by AI from conversation content — a photographer confirming a shoot is urgent, a lawyer sending a routine update is not. No code change needed.

**Scoring**: Unchanged. `selectOfferMultiplier` returns 1.0 for non-seller roles, which is correct for service CPs. They're important to the deal but don't have the seller commission premium.

---

## 5. Embedding Changes

### 5.1 Current approach

Per-message: `enrichMessage()` → `enriched_text` → `generateMessageEmbedding(enrichedText, channel, skipCleaning=true)` → 768-dim vector in `message_embeddings`.

Per-conversation: `rebuildConversationSummary()` → `analyzeConversation()` → summary text → `generateConversationEmbedding(messageTexts, summaryText)` → 768-dim vector in `conversation_threads.embedding`.

Threading currently uses conversation embeddings for similarity matching.

### 5.2 New approach: embeddings unchanged, threading replaced

Per-message embeddings stay as-is — embed enriched text of the individual message. Context-enriched embeddings (prepending N timeline items) were considered and rejected: successive messages from the same conversation would produce nearly identical embeddings because they share 90%+ of the same context window. The marginal signal isn't worth the complexity or cost.

Per-conversation embeddings stay as-is. Summary inputs improve naturally because Step 4.5 now feeds call logs and voice notes into `analyzeConversation()`.

**What replaces embedding-based threading**: The timeline-based conversation assignment algorithm (Section 3) handles what embeddings were trying to do — assigning messages to conversations. The density/recency heuristic + AI comprehension is more accurate than cosine similarity, especially for short messages ("ano") that produce meaningless embeddings.

**Embeddings remain useful for**: Conversation-level semantic search, quality signals for summaries, and potential future cross-CP conversation discovery.

---

## 6. Cron Changes

### 6.1 Current cron behavior

Agent pipeline runs every 5 minutes via QStash (`/api/agent/run`). Morning brief at user-configured times. Instant notifications poll every 5 minutes.

### 6.2 Timeline integration

No new cron jobs needed. The existing 5-minute cycle picks up timeline entries via the updated pipeline (Section 2). Brief generation reads `action_proposals` — the timeline is upstream, the brief never reads `deal_timeline` directly.

### 6.3 Call log awareness

When a `call_log` entry exists with no linked `voice_note`:

```sql
SELECT dt.*
FROM deal_timeline dt
WHERE dt.user_id = :userId
  AND dt.event_type = 'call_log'
  AND dt.conversation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM deal_timeline child
    WHERE child.parent_id = dt.id
      AND child.event_type = 'voice_note'
  )
  AND dt.occurred_at > now() - interval '24 hours'
```

No separate cron step needed. The call log is a timeline entry like any other — it flows through Step 4.5 (summary rebuild) and Step 5 (action proposal). The AI sees "a 3-minute call happened with no notes" in the timeline context and decides whether to flag it.

---

## 7. Call Log App Requirements

### 7.1 Core functionality

A mobile app that:
1. Detects when a phone call ends
2. Matches phone number against known CPs
3. If no match: prompts to create a new CP (name, email optional)
4. Logs the call to `deal_timeline` via API
5. Prompts to record a voice note
6. If recorded: uploads audio, transcribes, saves to `deal_timeline` with `parent_id`
7. If declined: creates a TODO for the user to follow up

### 7.2 API endpoints needed

**`POST /api/timeline/call-log`** — Log a phone call
```typescript
// Request
{
  userId: string,
  phoneNumber: string,      // "+420..."
  direction: 'in' | 'out',
  startedAt: string,        // ISO 8601
  duration: number,         // seconds
  cpId?: string,            // if already known
}

// Response
{
  timelineEntryId: string,
  cpId: string,
  cpName: string | null,
}
```

**`POST /api/timeline/voice-note`** — Attach a voice note to a call log
```typescript
// Request (multipart/form-data)
{
  userId: string,
  callLogEntryId: string,   // parent timeline entry
  audio: File,
}

// Response
{
  timelineEntryId: string,
  transcription: string,
}
```

**`GET /api/cp/lookup?phone=+420...&userId=...`** — Look up CP by phone
```typescript
// Response
{
  found: boolean,
  cp?: { id: string, name: string, role: string | null }
}
```

### 7.3 CP resolution for phone numbers

New query function needed:
```typescript
// In counterparties.ts
export async function getCPByPhone(userId: string, phone: string): Promise<CP | null> {
  const normalized = normalizePhoneNumber(phone)
  // Check primary_identifier
  // Check other_identifiers jsonb
  // Check channels table for whatsapp channel with this number
  // Return first match
}
```

### 7.4 Voice note transcription

Recommended: pay-per-call Whisper API (Replicate or similar). ~$0.003/minute. No infra to maintain. Alternative: Railway-hosted Whisper if cost becomes a concern at scale.

Decision on exact provider deferred until implementation.

### 7.5 Platform

Out of scope for this spec. The API endpoints above (7.2) are what Mila needs to expose. The mobile app itself is a separate project.

---

## 8. Conflicts, Risks, and Observations

### 8.1 CRITICAL — `getUnprocessedMessages` consumers

Current pipeline uses `getUnprocessedMessages(userId)` → `messages WHERE conversation_id IS NULL`. New pipeline replaces with `deal_timeline WHERE conversation_id IS NULL`.

Checked all callers: only `agent.ts` line 162. Safe to replace.

### 8.2 CRITICAL — Parallel ingestion and timeline writes

Steps 2/2.1 run in parallel, both write to `deal_timeline`. Each email gets a unique `message_id`, and the unique index prevents duplicates. Parallel writes are safe.

### 8.3 CRITICAL — Bulk ingestion

`bulk-ingestion.ts` writes to `messages` in Phase 1 and threads in Phase 3. Must be updated:
- Phase 1: also write to `deal_timeline`
- Phase 3: write `conversation_id` back to both `messages` and `deal_timeline`

**Implementation note**: `bulk-ingestion.ts` must be read in full before implementation. Not read in this session per CLAUDE.md performance rules.

### 8.4 RISK — Timeline entry without CP

`deal_timeline.cp_id` is NOT NULL. Messages with `cp_id = NULL` (filter skips, non-actionable, commands) do NOT get timeline entries. The timeline only tracks CP-related communication.

### 8.5 OBSERVATION — Enrichment still needed

Enrichment normalizes messy email text, extracts addresses/times/meeting types. The timeline augments enrichment, not replaces it. Enriched text goes into `deal_timeline.content` for email/WA events. Call logs and voice notes skip enrichment (already concise human input).

### 8.6 OBSERVATION — `computeDaysIgnored` needs timeline-aware version

`getLatestMessageFromCP()` queries `messages`. Must switch to `deal_timeline` so phone calls reset the "days since activity" counter.

New function: `getLatestTimelineEntryFromCP(userId, cpId)` → queries `deal_timeline WHERE direction = 'in' ORDER BY occurred_at DESC LIMIT 1`.

Both `planning.ts` and `lead-tracking.ts` must switch to timeline-based version.

### 8.7 OBSERVATION — Conversation embeddings remain valuable

The new assignment algorithm replaces embedding-based threading. But conversation embeddings remain useful for semantic search and summary quality. Keep generating them in `rebuildConversationSummary()`.

### 8.8 OBSERVATION — GDPR

`deleteAllUserData()` in `gdpr.ts` must include `deal_timeline`. CASCADE on `user_id` handles deletion automatically. `exportAllUserData()` needs an explicit query for timeline entries.

### 8.9 ROLLBACK PLAN

The timeline is additive — no existing tables modified. Rollback:

1. **Schema**: Drop `deal_timeline` table.
2. **Code**: Revert ingestion (remove timeline writes), revert threading to embedding similarity, revert planning/lead-tracking to `messages` queries.
3. **Data**: Zero data loss. `messages` stays in sync throughout via writeback.

Key safety: **`messages.conversation_id` is always populated** via writeback. All existing code that reads `messages` works correctly at all times. Partial rollback (disable timeline reads, keep writes) is also safe.

---

## Resolved Decisions Summary

| # | Decision | Resolution |
|---|----------|------------|
| 1 | CP role categories | Three tiers: RetailDeal, BusinessDeal, Service |
| 2 | CP role population | AI assigns, user approves/edits |
| 3 | Assignment context window | Up to 10 entries (use whatever exists, 10 is the max) |
| 4 | New conversation creation | Zero conversations = always new. AI says "NEW" = new. AI uncertain = ask user |
| 5 | Service CPs in lead tracking | Skip entirely |
| 6 | Scoring for service CPs | Unchanged (1.0 multiplier) |
| 7 | Embedding context | Not doing context-enriched embeddings. Embed per-message as today |
| 8 | Embedding context window | N/A — dropped |
| 9 | Voice transcription | Pay-per-call Whisper API (Replicate or similar). Provider TBD at implementation |
| 10 | Call log app platform | Out of scope. Mila exposes API endpoints; app is separate project |
| 11 | Call log app auth | Out of scope (part of app project) |
| 12 | Bulk ingestion | In scope. Phase 1 + Phase 3 updates needed. Code read required before implementation |
