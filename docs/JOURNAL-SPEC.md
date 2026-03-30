# Mila Journal & Learning System — Technical Spec

*Implementation plan against current codebase. References rough-spec-v3 + addendums 1 & 2.*

---

## Table of Contents

1. [Database Changes](#1-database-changes)
2. [New Files](#2-new-files)
3. [Modified Files](#3-modified-files)
4. [AI Model Configuration](#4-ai-model-configuration)
5. [Agent Pipeline Changes](#5-agent-pipeline-changes)
6. [Brief Redesign](#6-brief-redesign)
7. [Draft Timing Changes](#7-draft-timing-changes)
8. [QStash Additions](#8-qstash-additions)
9. [Onboarding Changes](#9-onboarding-changes)
10. [Implementation Order](#10-implementation-order)

---

## 1. Database Changes

### 1.1 New Table: `journal_entries`

```sql
CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('global', 'cp_id', 'conversation_id', 'temporal')),
  scope_ref       uuid,
  type            text NOT NULL CHECK (type IN ('observation', 'belief', 'volatile')),
  topic           text NOT NULL,
  content         text NOT NULL,
  confirm_count   int NOT NULL DEFAULT 1,
  conflict_count  int NOT NULL DEFAULT 0,
  weight          float NOT NULL DEFAULT 0.1,
  recency_score   float,
  language        text NOT NULL DEFAULT 'cs',
  expires_at      timestamptz,
  is_stale        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_journal_user_id ON journal_entries(user_id);
CREATE INDEX idx_journal_scope ON journal_entries(scope);
CREATE INDEX idx_journal_scope_ref ON journal_entries(scope_ref);
CREATE INDEX idx_journal_stale ON journal_entries(is_stale);
CREATE INDEX idx_journal_created ON journal_entries(created_at);
CREATE INDEX idx_journal_user_active ON journal_entries(user_id, is_stale, type);
```

**Scope semantics:**
- `global` — user-wide patterns (style, preferences). `scope_ref` = null.
- `cp_id` — counterparty-specific observations. `scope_ref` = counterparties.id.
- `conversation_id` — deal-specific context. `scope_ref` = conversation_threads.id.
- `temporal` — deadline/event-specific. `scope_ref` = conversation_threads.id or null. Must have `expires_at`.

**Type lifecycle:**
- `observation` — single data point, low planning weight. Promoted to `belief` at confirm_count >= 3.
- `belief` — established pattern. Weight = min(confirm_count, 25) x recency_factor.
- `volatile` — belief with unresolved contradictions (conflict_count >= 3, contradiction analysis failed to resolve). Surfaced to user.

### 1.2 New Columns on `action_proposals`

```sql
ALTER TABLE action_proposals
  ADD COLUMN original_draft_body text,
  ADD COLUMN original_intent_cs text;
```

- `original_draft_body` — written at draft creation time (step 5.5 for REPLY, brief-time for SCHEDULE). Never overwritten. The reflection call compares this against final `draft_body_text` to extract what the user changed.
- `original_intent_cs` — written at proposal creation time (step 5 in planning). Never overwritten. Compared against final `intent_cs` after user edits.

**Write points:**
- `original_intent_cs`: set in `createAction()` in planning.ts, same value as `intent_cs` at proposal time.
- `original_draft_body`: set alongside `draft_body_text` at first draft generation. In the existing `updateActionDraft()` function, only write `original_draft_body` if it's currently null (preserve first version).

### 1.3 Schema Documentation

Add journal_entries to docs/SCHEMA.md under a new "Journal & Learning" section.

---

## 2. New Files

### 2.1 `src/lib/db/journal.ts`

Follows existing db/ pattern (import getSupabaseAdmin, typed functions, user_id filtering).

```typescript
// --- Reads ---

// Active entries for planning context. Ordered by weight desc, updated_at desc.
// Reads: global + all active conversation_id + all cp_id scoped entries.
getActiveJournalEntries(userId: string, opts?: {
  scope?: string,
  scopeRef?: string,
  types?: string[],    // default: all
  limit?: number       // default: 50
}): Promise<JournalEntry[]>

// Entries relevant to a specific set of conversations + their CPs.
// Used by planning stage to get scoped context.
getJournalEntriesForContext(userId: string, conversationIds: string[], cpIds: string[]): Promise<JournalEntry[]>

// Recent observations for reflection (last 7 days).
getRecentJournalEntries(userId: string, sinceDays?: number): Promise<JournalEntry[]>

// All non-stale beliefs for belief email.
getAllBeliefs(userId: string): Promise<JournalEntry[]>

// --- Writes ---

// Insert new observation.
createJournalEntry(entry: JournalEntryInsert): Promise<JournalEntry>

// Increment confirm_count + update recency. Promote to belief if count >= 3.
confirmObservation(entryId: string): Promise<JournalEntry>

// Increment conflict_count. Flag volatile if count >= 3.
recordConflict(entryId: string): Promise<JournalEntry>

// Match incoming observation against existing entries (same user_id + scope + scope_ref + topic).
findMatchingEntry(userId: string, scope: string, scopeRef: string | null, topic: string): Promise<JournalEntry | null>

// Replace belief content (used by contradiction analysis when pattern found).
replaceBeliefContent(entryId: string, newContent: string, resetCounts?: boolean): Promise<void>

// Mark stale by scope_ref (called when conversation archived).
markStaleByConversation(conversationId: string): Promise<void>

// Mark stale by expiry (called periodically or at cycle start).
expireTemporalEntries(): Promise<number>

// Delete entry (user action via belief email).
deleteJournalEntry(entryId: string): Promise<void>

// Bulk insert (onboarding seed).
createJournalEntries(entries: JournalEntryInsert[]): Promise<JournalEntry[]>
```

**Type definition** — add `JournalEntry` and `JournalEntryInsert` to `src/lib/supabase/types.ts`, matching the table schema.

### 2.2 `src/services/reflection.ts`

The reflection service. Called at end of agent cycle (step 7).

```typescript
// Main entry point. Called from agent.ts after all other steps.
runReflection(userId: string): Promise<ReflectionResult>

// Internal: gather input data for the reflection prompt.
gatherReflectionInput(userId: string): Promise<ReflectionInput>

// Internal: call Haiku with structured prompt, get observations.
callReflectionAI(input: ReflectionInput, settings: UserSettings): Promise<ReflectionOutput>

// Internal: process AI output against existing journal entries.
// Handles: insert new, confirm existing, record conflicts, promote to belief.
processReflectionOutput(userId: string, output: ReflectionOutput): Promise<ProcessResult>
```

**ReflectionInput structure:**
```typescript
interface ReflectionInput {
  // Actions proposed in PREVIOUS cycle(s) that the user has since acted on
  actedOnActions: {
    actionId: string
    actionType: string
    cpName: string
    originalIntentCs: string | null
    finalIntentCs: string
    originalDraftBody: string | null
    finalDraftBody: string | null
    userAction: 'approved' | 'completed' | 'dismissed'  // derived from status
    editedTo: string | null      // if recipient was changed
    userNotes: string | null     // from payload.userNotes
  }[]

  // Timeline changes since last reflection
  recentTimelineChanges: {
    cpId: string
    cpName: string
    eventType: string     // email, whatsapp, call_log, voice_note
    direction: string
    occurredAt: string
    conversationId: string | null
  }[]

  // Recent journal entries (last 7 days) for context
  recentJournalEntries: JournalEntry[]
}
```

**How to determine "acted on" actions:**
- Query `action_proposals` where `status IN ('approved', 'completed', 'dismissed')` AND `updated_at > last_reflection_at`.
- `last_reflection_at` stored in user settings (new field, see below) or derived from most recent journal entry's `created_at`.
- Compare `original_intent_cs` vs `intent_cs` and `original_draft_body` vs `draft_body_text` to detect edits.

**New UserSettings field:**
```sql
-- Add to users.settings JSONB
last_reflection_at: timestamptz  -- null initially, set after each reflection
```

**ReflectionOutput (strict JSON schema for Haiku):**
```typescript
interface ReflectionOutput {
  observations: {
    scope: 'global' | 'cp_id' | 'conversation_id' | 'temporal'
    scope_ref: string | null
    topic: string
    content: string
    expires_at: string | null   // ISO datetime, temporal only
  }[]
  abstain_reason: string | null  // why Haiku chose not to write anything
}
```

**processReflectionOutput logic (no AI, pure DB):**
```
for each observation in output:
  existing = findMatchingEntry(userId, scope, scopeRef, topic)
  if no existing:
    createJournalEntry(observation) → type='observation', count=1
  else:
    if observation confirms existing:
      confirmObservation(existing.id)
      if existing.confirm_count >= 3 and existing.type == 'observation':
        promote to 'belief' (update type, recalculate weight)
    else if observation contradicts existing:
      recordConflict(existing.id)
      if existing.conflict_count >= 3:
        trigger contradiction analysis (QStash async job)
```

**Confirming vs contradicting:**
The reflection prompt explicitly asks Haiku to label each observation as `confirming` or `contradicting` relative to existing entries it receives as context. This avoids NLP-based similarity comparison.

Updated ReflectionOutput observation:
```typescript
{
  scope: string
  scope_ref: string | null
  topic: string
  content: string
  expires_at: string | null
  relation_to_existing: 'new' | 'confirming' | 'contradicting'
  existing_topic_match: string | null  // topic of the entry this confirms/contradicts
}
```

### 2.3 `src/app/api/cron/belief-audit/route.ts`

Endpoint for monthly/quarterly Opus belief audit. Called by QStash schedule.

```typescript
POST /api/cron/belief-audit?userId=<uuid>
Auth: CRON_SECRET
```

**Flow:**
1. Validate cron secret
2. Fetch all non-stale beliefs for user via `getAllBeliefs(userId)`
3. Call Opus with full belief set
4. Opus returns recommendations: too-broad beliefs, under-confirmed, stale volatile, merge candidates
5. Write audit results as a journal entry (scope: global, type: observation, topic: 'belief_audit_results')
6. Trigger belief email to user with recommendations

### 2.4 `src/app/api/cron/contradiction-analysis/route.ts`

Endpoint for async contradiction analysis. Called by QStash when conflict_count >= 3.

```typescript
POST /api/cron/contradiction-analysis
Auth: CRON_SECRET
Body: { userId, entryId }
```

**Flow:**
1. Fetch the volatile entry + all observations on same topic
2. Call Sonnet: "These observations contradict. Is there a pattern? (e.g., user is aggressive with sellers but gentle with buyers)"
3. If pattern found → replace belief with narrower scoped version, reset counts
4. If no pattern → escalate to Opus (same endpoint, flag in payload)
5. If Opus finds pattern → same as step 3
6. If Opus finds no pattern → flag as volatile, type='volatile'. Will surface to user in next brief.

### 2.5 `src/app/api/beliefs/route.ts`

Endpoint to trigger belief email send.

```typescript
GET /api/beliefs?userId=<uuid>&token=<hmac>
Auth: Action token (same HMAC pattern as action cards)
```

**Flow:**
1. Validate token
2. Fetch all non-stale beliefs grouped by scope
3. Generate belief email HTML
4. Send via existing email infrastructure
5. Return redirect to "email sent" confirmation page (or simple JSON)

---

## 3. Modified Files

### 3.1 `src/config/ai-models.ts`

**Current state:** 7 stages (`filter`, `classify`, `enrichment`, `threading`, `analysis`, `planning`, `drafting`).

**Add 5 new stages:**

```typescript
export type AIStage =
  | 'filter' | 'classify' | 'enrichment' | 'threading'
  | 'analysis' | 'planning' | 'drafting'
  // New stages:
  | 'reflection'                // journal observation extraction
  | 'draft_edit'                // Haiku gap-fill + spell/grammar on save
  | 'contradiction_analysis'    // resolve conflicting beliefs
  | 'contradiction_escalation'  // Opus fallback for unresolved contradictions
  | 'belief_audit'              // monthly/quarterly full belief review
```

**New model chains:**

| Stage | Primary | Fallback 1 | Temperature | Thinking |
|-------|---------|-----------|-------------|----------|
| reflection | claude-haiku-4-5-20251001 | gemini-2.5-flash-lite | 0 | — |
| draft_edit | claude-haiku-4-5-20251001 | gemini-2.5-flash-lite | 0 | — |
| contradiction_analysis | claude-sonnet-4-6 | gemini-2.5-flash | — | 4096 |
| contradiction_escalation | claude-opus-4-6 | claude-sonnet-4-6 | — | 8192 |
| belief_audit | claude-opus-4-6 | claude-sonnet-4-6 | — | 8192 |

**Note on Opus:** First use of Opus in the codebase. The existing Anthropic provider (`src/lib/ai/providers/anthropic.ts`) uses `ANTHROPIC_API_KEY` and the `@anthropic-ai/sdk`. It already supports any model string — just pass `claude-opus-4-6` as the model parameter. No provider changes needed. Verify API key tier supports Opus.

**Note on Haiku-primary stages:** reflection and draft_edit are Haiku-primary (not Gemini) because the spec requires reliable Czech output. Gemini Flash has documented Czech bleed issues. Haiku handles structured Czech extraction reliably.

### 3.2 `src/services/agent.ts`

**Current pipeline:** Steps 0, 1, 2/2.1/2.5 (parallel), 3, 4, 4.5, 5, 6.

**New pipeline:**

```
Step 0:   purgeUserAsCp (unchanged)
Step 0.5: READ JOURNAL — load active journal entries for this user.
          Call expireTemporalEntries() to clean expired entries.
          Store in variable for passing to planning.
Step 1:   Verify user credentials (unchanged)
Steps 2/2.1/2.5: Parallel ingestion (unchanged)
Step 3:   Load unassigned timeline entries (unchanged)
Step 4:   Thread into conversations (unchanged)
Step 4.5: Rebuild conversation summaries (unchanged)
Step 5:   Generate action proposals (MODIFIED — receives journal entries)
Step 5.5: GENERATE REPLY DRAFTS — for all new REPLY actions from step 5.
          Call generateFinalDraft() for each REPLY action.
          Write draft_body_text + draft_subject + original_draft_body.
          Batched x5 (same as planning concurrency).
          SCHEDULE actions skipped here (JIT at brief time).
Step 6:   Lead tracking (unchanged)
Step 7:   REFLECTION — call runReflection(userId).
          Async-safe: errors logged, never fail the pipeline.
          Update last_reflection_at in user settings.
```

**Step 0.5 detail:**
```typescript
// Load journal context for this cycle
const journalEntries = await getActiveJournalEntries(userId, { limit: 50 })
await expireTemporalEntries() // clean up expired temporal entries
```

**Step 5 modification:**
Pass `journalEntries` to `generateActionsForConversations()`. The planning stage uses these as additional context in the proposeAction prompt. See section 3.3.

**Step 5.5 detail:**
```typescript
// Generate REPLY drafts immediately after planning
const replyActions = newActions.filter(a => a.action_type === 'REPLY')
const DRAFT_CONCURRENCY = 5
for (const chunk of chunks(replyActions, DRAFT_CONCURRENCY)) {
  await Promise.allSettled(chunk.map(async (action) => {
    const conv = await getConversationById(action.conversation_id)
    const cp = await getCPById(action.cp_id)
    const draft = await generateFinalDraft(
      conv.summary_json, action.intent_cs, settings,
      null, action.missing_info, cp?.name, action.payload?.channel
    )
    await updateActionDraft(action.id, draft.subject, draft.body)
    // Set original_draft_body (first write only)
    await updateAction(action.id, { original_draft_body: draft.body })
  }))
}
```

**Step 7 detail:**
```typescript
// Reflection — end of cycle
try {
  await runReflection(userId)
  await updateUserSettings(userId, { last_reflection_at: new Date().toISOString() })
  result.logs.push('[Agent] Step 7: Reflection complete')
} catch (err) {
  result.logs.push(`[Agent] Step 7: Reflection failed — ${err}`)
  // Non-fatal: don't fail the pipeline
}
```

**AgentRunResult additions:**
```typescript
{
  // existing fields...
  reflectionObservations: number  // count of journal entries written in step 7
  replyDraftsGenerated: number    // count of drafts generated in step 5.5
}
```

### 3.3 `src/services/planning.ts`

**Change 1: Accept journal entries**

`generateActionsForConversations` signature change:
```typescript
// Before:
generateActionsForConversations(conversationIds: string[]): Promise<ActionProposal[]>

// After:
generateActionsForConversations(conversationIds: string[], journalEntries?: JournalEntry[]): Promise<ActionProposal[]>
```

Passed down to `generateActionProposal()`:
```typescript
// Before:
generateActionProposal(conversation: ConversationThread): Promise<ActionProposal[]>

// After:
generateActionProposal(conversation: ConversationThread, journalEntries?: JournalEntry[]): Promise<ActionProposal[]>
```

**Change 2: Filter journal entries per conversation**

Inside `generateActionProposal`, before calling `proposeAction`:
```typescript
// Filter journal entries relevant to this conversation + its CP
const relevantJournal = (journalEntries || []).filter(e =>
  e.scope === 'global' ||
  (e.scope === 'conversation_id' && e.scope_ref === conversation.id) ||
  (e.scope === 'cp_id' && e.scope_ref === cp?.id)
)
```

**Change 3: Pass journal to proposeAction prompt**

In the `proposeAction` function in `src/lib/ai/gemini.ts`, add a new section to the prompt:

```
MILA'S OBSERVATIONS (from prior cycles):
${relevantJournal.map(e => `- [${e.type}/${e.scope}] ${e.content} (weight: ${e.weight})`).join('\n')}
```

Inserted after the conversation context, before the action type rules. This gives the AI awareness of:
- User style preferences (global beliefs)
- CP behavioral patterns (cp_id beliefs)
- Deal-specific context and deadlines (conversation_id entries)
- Upcoming temporal deadlines (temporal entries)

**Change 4: Write original_intent_cs**

In the `createAction` call, add:
```typescript
original_intent_cs: proposal.intent_cs
```

### 3.4 `src/services/morning-brief.ts`

This is the largest change. The current file generates a flat list of action cards. The new structure is time-aware and differentiated between AM and PM.

**Keep unchanged:**
- `sendAllMorningBriefs()` — batch orchestration
- `sendInstantNotifications()` — urgent notification flow
- `sendInstantNotificationForConversation()` — per-conversation urgent send
- `generateInstantNotifyEmailHtml()` — urgent notification template
- Action ordering logic (group by conversation, urgency-first, TODO suppresses CP action)
- Token generation, URL construction
- `markActionsNotified()` / `markActionsInstantNotified()` calls

**Modify: `sendMorningBrief()`**

Current flow:
1. Load user, settings
2. Optimize schedules
3. Fetch actions, completed items
4. Branch: quiet vs normal
5. Generate HTML, send

New flow:
1. Load user, settings
2. Optimize schedules
3. Fetch actions, completed items
4. **Fetch today's events with conversation synopses**
5. **Fetch journal entries (beliefs + temporal)**
6. **Fetch cooling/upcoming deals**
7. **Fetch tomorrow's events (for PM)**
8. **Fetch next 3 days events (for AM)**
9. **Fetch todos (due today + overdue)**
10. Branch: quiet vs normal
11. **Generate time-aware HTML based on briefType**
12. Send

**New data fetching (step 4-9):**
```typescript
// Today's events with conversation context
const todayEvents = await getEventsForToday(userId, settings.timezone)
const enrichedEvents = await enrichEventsWithSynopsis(todayEvents, userId)

// Journal beliefs for brief intro context
const beliefs = await getActiveJournalEntries(userId, {
  types: ['belief', 'volatile'],
  limit: 20
})

// Temporal journal entries (upcoming deadlines)
const temporalEntries = await getActiveJournalEntries(userId, {
  scope: 'temporal',
  limit: 10
})

// Cooling leads (from lead tracking, not just actions)
// Reuse getConversationsForUser with status filter
const coolingConversations = await getCoolingDeals(userId) // new helper

// Tomorrow + next 3 days
const tomorrowEvents = await getEventsInRange(userId, tomorrowStart, tomorrowEnd)
const next3DaysEvents = await getEventsInRange(userId, tomorrowStart, threeDaysEnd)

// Todos
const todosDueToday = await getTodosDueToday(userId)
const overdueTodos = await getOverdueTodos(userId)
```

**New helper function: `enrichEventsWithSynopsis()`**
```typescript
async function enrichEventsWithSynopsis(
  events: Event[],
  userId: string
): Promise<EnrichedEvent[]> {
  return Promise.all(events.map(async (event) => {
    let synopsis: string | null = null
    if (event.conversation_id) {
      const conv = await getConversationById(event.conversation_id)
      if (conv?.summary_json) {
        // Extract key context from conversation summary
        synopsis = conv.summary_json.current_status
          || conv.summary_json.summary
          || null
      }
    }
    return { ...event, synopsis }
  }))
}
```

**New helper function: `getCoolingDeals()`**
```typescript
// Conversations with no recent activity but not snoozed or archived
// Uses existing getConversationsForUser + getLatestInboundFromCP
async function getCoolingDeals(userId: string): Promise<CoolingDeal[]>
```

This reuses existing lead-tracking logic but without generating actions — just returns the data for display in the brief.

#### AM Brief HTML: `generateAMBriefEmailHtml()`

New function replacing `generateBriefEmailHtml()` for morning briefs.

```
┌─────────────────────────────────────────────────┐
│ GREETING + HEADLINE                             │
│ (AI-generated, journal-informed, urgency-aware) │
├─────────────────────────────────────────────────┤
│ ON FIRE (if any actions with urgency >= 9)      │
│ Red background, impossible to miss              │
│ Full action cards for urgent items              │
├─────────────────────────────────────────────────┤
│ YOUR MORNING                                    │
│ (working_hours_start → +3hrs, fuzzy boundary)   │
│                                                 │
│ 09:00  Martin Kral — Smíchov closing            │
│        "Bank needs mortgage approval +           │
│         property valuation. 12 working days      │
│         to deadline."                            │
│        [ACTION CARD if action exists]            │
│                                                 │
│ 09:45  ---                                      │
│        "Good window to [journal suggestion]"     │
│                                                 │
│ 10:30  Eva Dvorakova — office viewing            │
│        "Comparing 3 locations, budget 45K/mo"    │
│        [ACTION CARD if action exists]            │
├─────────────────────────────────────────────────┤
│ REST OF TODAY                                   │
│ (lighter rendering — time + title + flags only)  │
│                                                 │
│ 13:00  Notary signing — Novotny                  │
│ 15:30  [free]                                    │
│        Actions without calendar ties shown here  │
├─────────────────────────────────────────────────┤
│ NEEDS ATTENTION                                 │
│ Cooling deals + overdue todos                   │
│                                                 │
│ ⚠ Petra Svobodova — no response in 4 days       │
│ ⚠ TODO overdue: send Kral floor plans           │
├─────────────────────────────────────────────────┤
│ NEXT 3 DAYS                                     │
│ Headline-level, grouped                         │
│                                                 │
│ Tomorrow: 2 viewings, Novotny signing            │
│ Wednesday: empty — "klidny den"                  │
│                                                 │
│ Individual items with urgency > 4-5 get a line.  │
│ Low-priority items grouped: "admin, viewing prep" │
├─────────────────────────────────────────────────┤
│ CO UZ MILA VYRIDILA                             │
│ (completed actions — existing section, enriched) │
├─────────────────────────────────────────────────┤
│ FOOTER                                          │
│ "Zobrazit co si Mila mysli" button              │
│ → triggers belief email                         │
└─────────────────────────────────────────────────┘
```

**"Your morning" boundary logic:**
```typescript
const workStart = settings.working_hours_start || 9  // e.g. 9
const morningEnd = workStart + 3  // e.g. 12
// But fuzzy: if there's a meeting at 12:15, include it.
// If the last morning event ends at 11:30 and next is 14:00, cut at 11:30.
```

The boundary is not a hard cutoff — it's the natural break in the schedule around the 3-hour mark.

**Gap suggestion logic:**
```typescript
// Find gaps > 30 minutes in the morning block
const gaps = findGapsInSchedule(morningEvents, morningStart, morningEnd)
for (const gap of gaps) {
  if (gap.durationMinutes >= 30) {
    // Find a relevant action or temporal journal entry
    // that could be addressed in this window
    const suggestion = findGapSuggestion(gap, pendingActions, temporalEntries, beliefs)
    // suggestion might be null — unscheduled time is fine
  }
}
```

**Gap suggestions come from (priority order):**
1. Temporal journal entries with approaching deadlines
2. Pending actions not tied to specific events, ordered by priority_score
3. Nothing — "unscheduled time" is fine, don't force fill

#### PM Brief HTML: `generatePMBriefEmailHtml()`

New function for afternoon briefs.

```
┌─────────────────────────────────────────────────┐
│ GREETING + HEADLINE                             │
│ (PM-framed: "day's wrapping up" tone)           │
├─────────────────────────────────────────────────┤
│ ON FIRE (if any, same as AM)                    │
├─────────────────────────────────────────────────┤
│ TOMORROW                                        │
│ (detailed — same depth as AM "your morning")    │
│                                                 │
│ Events with synopses, linked actions            │
│ Prep suggestions for tomorrow's meetings        │
├─────────────────────────────────────────────────┤
│ STILL PENDING FROM TODAY                        │
│ Actions user hasn't acted on yet                │
│ (already sent in AM, now reminder)              │
├─────────────────────────────────────────────────┤
│ NEXT 2-3 DAYS                                   │
│ More detail than AM's 3-day view:               │
│ Individual items that were grouped in AM now     │
│ get their own line. Progressive disclosure.      │
├─────────────────────────────────────────────────┤
│ NEEDS ATTENTION                                 │
│ Same as AM but updated with day's activity      │
├─────────────────────────────────────────────────┤
│ CO UZ MILA VYRIDILA                             │
│ (today's completed actions)                     │
├─────────────────────────────────────────────────┤
│ FOOTER with beliefs button                      │
└─────────────────────────────────────────────────┘
```

**Key PM difference from AM:**
- Tomorrow is the focus section (detailed), not today
- "Still pending" replaces action cards — lighter rendering, nudge tone
- 3-day lookahead has more resolution than AM's grouped view
- No "your morning" section — day is ending

**Progressive disclosure across AM → PM → next AM:**
- Monday AM: "This week: 3 closings, 2 viewings" (grouped)
- Monday PM: Tomorrow's events detailed, Wed-Thu get individual lines
- Tuesday AM: Tuesday detailed, Wed preview

No repeated content at the same zoom level. Each brief adds resolution.

#### Updated `generateBriefIntro()` call

The `generateBriefIntro()` in mila-voice.ts needs additional context:

```typescript
// Before:
generateBriefIntro(briefType, actionCount, events, pendingActions, settings)

// After:
generateBriefIntro(briefType, actionCount, events, pendingActions, settings, {
  beliefs: relevantBeliefs,           // user style + deal patterns
  temporalDeadlines: temporalEntries, // approaching deadlines
  coolingDeals: coolingDeals,         // deals going quiet
  tomorrowEventCount: number,         // for PM context
})
```

The AI uses this to write a headline that reflects Mila's actual understanding, not just a count of actions.

#### Quiet Brief

Quiet brief remains but gains the same structural improvements:
- Today's schedule (already exists)
- Tomorrow preview (new)
- Temporal deadlines from journal (new)
- Beliefs footer button (new)

### 3.5 `src/lib/ai/mila-voice.ts`

**New functions:**

```typescript
// Generate belief email HTML content
generateBeliefEmailHtml(
  beliefs: JournalEntry[],
  settings: UserSettings
): string
// Pure HTML generation, no AI call. Groups by scope, renders weight indicators.

// No new AI generation functions needed — the reflection prompt lives in
// reflection.ts and calls runAITask('reflection', prompt) directly.
```

**Modified functions:**

`generateBriefIntro()` — expanded signature (see 3.4 above). The prompt gains awareness of journal beliefs and temporal deadlines so the headline can reference Mila's understanding of the user's world.

`generateFinalDraft()` — add journal entries as optional context:
```typescript
// After (additional optional param):
generateFinalDraft(
  conversationContext, intent, settings, userNotes?, missingInfo?,
  cpName?, channel?, journalEntries?: JournalEntry[]
)
```

When present, the draft prompt includes CP-scoped beliefs (e.g., "Bob prefers WhatsApp, responds quickly to short messages") so the draft tone adapts.

### 3.6 `src/app/api/action/[id]/draft/route.ts`

**PUT handler changes (Haiku regeneration on save):**

After the existing dynamic fields processing and notes handling, add:

```typescript
// After all field updates are saved, regenerate draft via Haiku
const updatedAction = await getActionById(actionId)
if (updatedAction.draft_body_text) {
  const regenerated = await runAITask('draft_edit', buildGapFillPrompt(
    updatedAction.draft_body_text,
    updatedAction.missing_info,      // filled values
    updatedAction.payload?.userNotes
  ))
  const parsed = JSON.parse(regenerated)
  await updateActionDraft(actionId, parsed.subject, parsed.body)
}
```

**Haiku gap-fill prompt structure:**
```
You are editing an email/message draft. Two jobs:
1. GAP FILL: If the user answered questions that were left blank, weave the
   answers into the surrounding text grammatically.
2. SPELL/GRAMMAR: Fix any spelling or grammar errors in user-edited text.

Do NOT change the tone, intent, or meaning. Do NOT add new content.
Output language: ${settings.ai_language}

CURRENT DRAFT:
${draftBody}

FILLED FIELDS:
${filledFields.map(f => `${f.label}: ${f.value}`).join('\n')}

USER NOTES:
${userNotes || 'none'}

Return valid JSON: { "subject": "...", "body": "..." }
```

**POST handler changes:**

When generating a draft for REPLY actions, check if `draft_body_text` already exists (pre-generated in step 5.5). If so, return it without regenerating. Current code already does this check — no change needed.

For SCHEDULE actions, drafts are still JIT (generated here after optimizer has run). No change to SCHEDULE draft flow.

### 3.7 `src/app/api/action/[id]/execute/route.ts`

**REPLY execution change:**

The JIT draft generation fallback remains for safety, but the primary path now uses the pre-generated draft from step 5.5:

```typescript
// Current (line 66):
if (!draftBody) {
  // generate draft JIT
}

// New:
if (!draftBody) {
  // Fallback: JIT generation (should be rare — step 5.5 normally handles this)
  console.warn(`[Execute] REPLY action ${actionId} had no pre-generated draft, generating JIT`)
  // ... existing JIT generation code unchanged
}
```

No structural change — just a log warning when the fallback triggers, to track how often step 5.5 misses.

### 3.8 `src/lib/qstash/client.ts`

**New functions:**

```typescript
// Trigger async contradiction analysis
publishContradictionAnalysis(userId: string, entryId: string): Promise<string>
// Publishes to /api/cron/contradiction-analysis with { userId, entryId }

// Create belief audit schedule (per-user)
createBeliefAuditSchedule(userId: string, isNew: boolean): Promise<string>
// isNew=true → monthly ("0 3 1 * *" = 1st of month at 3am)
// isNew=false → quarterly ("0 3 1 1,4,7,10 *" = 1st of Jan/Apr/Jul/Oct at 3am)
// Target: /api/cron/belief-audit?userId=<uuid>

// Delete belief audit schedule
deleteBeliefAuditSchedule(scheduleId: string): Promise<void>

// Switch audit frequency (called at 3-month mark)
switchBeliefAuditToQuarterly(userId: string, oldScheduleId: string): Promise<string>
```

**New UserSettings fields for schedule IDs:**
```typescript
belief_audit_schedule_id: string | null
belief_audit_created_at: string | null  // to determine monthly → quarterly switch
```

### 3.9 `src/lib/db/actions.ts`

**`updateActionDraft()` modification:**

```typescript
// Before:
export async function updateActionDraft(
  actionId: string, subject: string, body: string
): Promise<void>

// After:
export async function updateActionDraft(
  actionId: string, subject: string, body: string
): Promise<void> {
  // Read current action to check if original_draft_body needs setting
  const current = await getActionById(actionId)
  const updates: Record<string, unknown> = {
    draft_subject: subject,
    draft_body_text: body,
  }
  // Preserve original draft (first write only)
  if (!current?.original_draft_body) {
    updates.original_draft_body = body
  }
  await supabase.from('action_proposals').update(updates).eq('id', actionId)
}
```

This ensures `original_draft_body` is set on first draft generation and never overwritten by subsequent edits.

### 3.10 `src/lib/db/index.ts`

Add barrel re-export for journal.ts:
```typescript
export * from './journal'
```

---

## 4. AI Model Configuration

### Full stage table after changes:

| Stage | Purpose | Primary | Fallback 1 | Temp | Thinking |
|-------|---------|---------|-----------|------|----------|
| filter | Spam detection | gemini-2.5-flash-lite | claude-haiku-4-5-20251001 | 0 | — |
| classify | Email categorization | gemini-2.5-flash-lite | claude-haiku-4-5-20251001 | 0 | — |
| enrichment | Message extraction | gemini-2.5-flash | claude-haiku-4-5-20251001 | 0 | — |
| threading | Conversation grouping | gemini-2.5-flash | claude-sonnet-4-6 | 0 | — |
| analysis | Conversation summary | gemini-2.5-flash | claude-sonnet-4-6 | — | — |
| planning | Action proposals | gemini-2.5-flash | claude-sonnet-4-6 | — | 8192 |
| drafting | Email/message drafting | gemini-2.5-flash | claude-sonnet-4-6 | — | — |
| **reflection** | **Journal observations** | **claude-haiku-4-5-20251001** | **gemini-2.5-flash-lite** | **0** | **—** |
| **draft_edit** | **Gap fill + grammar** | **claude-haiku-4-5-20251001** | **gemini-2.5-flash-lite** | **0** | **—** |
| **contradiction_analysis** | **Resolve conflicts** | **claude-sonnet-4-6** | **gemini-2.5-flash** | **—** | **4096** |
| **contradiction_escalation** | **Opus fallback** | **claude-opus-4-6** | **claude-sonnet-4-6** | **—** | **8192** |
| **belief_audit** | **Full belief review** | **claude-opus-4-6** | **claude-sonnet-4-6** | **—** | **8192** |

### Cost implications per user per day:

| Call | Frequency | Model | Est. tokens |
|------|-----------|-------|-------------|
| Reflection | 2x/day (AM+PM cycle) | Haiku | ~2K in, ~500 out |
| Draft edit | ~3x/day (user edits) | Haiku | ~1K in, ~1K out |
| Contradiction analysis | ~1x/month | Sonnet | ~3K in, ~1K out |
| Contradiction escalation | ~1x/quarter | Opus | ~5K in, ~2K out |
| Belief audit | 1x/month or 1x/quarter | Opus | ~5K in, ~2K out |

Reflection and draft_edit are the recurring costs. Both use Haiku. At 500 users: ~2000 Haiku calls/day for reflection + ~1500 for draft edits = ~3500 Haiku calls/day. Negligible cost.

---

## 5. Agent Pipeline Changes

### Updated pipeline diagram:

```
Step 0:   purgeUserAsCp
Step 0.5: READ JOURNAL (new) — load beliefs + temporal entries, expire stale
Step 1:   Verify user credentials
Steps 2/2.1/2.5: Parallel ingestion (unchanged)
Step 3:   Load unassigned timeline entries
Step 4:   Thread into conversations
Step 4.5: Rebuild conversation summaries
Step 5:   Generate action proposals (MODIFIED — journal context in prompt)
Step 5.5: GENERATE REPLY DRAFTS (new) — Sonnet, batched x5
Step 6:   Lead tracking
Step 7:   REFLECTION (new) — Haiku, async-safe
```

### Timeout considerations:

Current agent cycle runs within Vercel's function timeout. Adding step 5.5 (REPLY drafts) and step 7 (reflection) extends the cycle.

- Step 5.5: ~3-5 seconds per draft x 5 concurrent = ~5 seconds per batch. Typical cycle produces 2-5 REPLY actions = one batch.
- Step 7: single Haiku call = ~2-3 seconds.

Total added: ~8 seconds. Well within limits.

If REPLY action count is high (bulk ingestion aftermath), step 5.5 could take longer. Cap at 3 batches (15 REPLY drafts) per cycle — remaining drafts generated in next cycle or JIT at brief time.

---

## 6. Brief Redesign

### Core principle:

Each brief is a **window into Mila's model of the user's world at the right zoom level for the moment.** Not a list of actions. Not a calendar dump. A strategic briefing.

### AM vs PM differentiation:

| Aspect | AM Brief | PM Brief |
|--------|----------|----------|
| Focus section | Today's first work block (detailed) | Tomorrow (detailed) |
| Calendar depth | Today full, next 3 days headline | Tomorrow full, next 2-3 days with more detail |
| Actions | Current pending, grouped by urgency | Still pending (reminder), tomorrow's prep |
| Tone | "Here's your day, let's go" | "Wrapping up, here's tomorrow" |
| Progressive disclosure | Groups low-priority upcoming items | Splits out items that were grouped in AM |

### Event ↔ action integration:

Currently events and actions are rendered separately. In the new brief, they're interleaved by time:

```
09:00  [EVENT] Martin Kral — Smíchov closing
       Synopsis from conversation summary
       [ACTION CARD] TODO: Get bank documents (urgency 7)

10:30  [EVENT] Eva Dvorakova — viewing
       Synopsis from conversation summary

11:00  [GAP — 45 min]
       "Dobrý čas zavolat Bobovi ohledně Vinohradské"

11:45  [ACTION without event] Bob — check pricing
       [ACTION CARD] TODO: Verify availability (urgency 3)
```

Actions tied to events appear under their event. Actions without events appear in gaps or in the "rest of day" section, ordered by priority.

### How events get linked to actions:

Events already have `conversation_id` (for Mila-created events). Actions have `conversation_id`. Match on conversation_id. For events without conversation_id (manually created, weight 7), no action linkage — they appear as calendar-only items.

### Quiet brief upgrade:

When no actions exist, the brief still shows:
- Today's schedule with synopses (existing, enhanced)
- Tomorrow preview (new)
- Temporal deadlines from journal (new)
- Cooling deals (new)
- Beliefs footer button (new)

A quiet day is still a briefed day.

### Beliefs footer:

Every brief (normal, quiet, PM) includes a footer:
```html
<div style="text-align: center; padding: 24px; border-top: 1px solid #e5e7eb;">
  <a href="/api/beliefs?userId=X&token=Y"
     style="color: #6b7280; font-size: 13px; text-decoration: none;">
    Co si Mila mysli →
  </a>
</div>
```

Small, unobtrusive. Always present. The user can check anytime.

### Volatile belief surfacing:

If any beliefs are flagged volatile since the last brief, add a one-line mention:
```html
<div style="padding: 12px 24px; background: #fef3cd; border-left: 3px solid #d97706;">
  <span style="font-size: 14px;">
    Mila si vsimla rozporuplnych vzorcu —
    <a href="/api/beliefs?userId=X&token=Y">zkontrolujte jeji uvazovani</a>
  </span>
</div>
```

---

## 7. Draft Timing Changes

### Summary of draft generation points:

| Action Type | When Generated | Model | Where in Code |
|-------------|---------------|-------|---------------|
| REPLY | Step 5.5 (agent cycle) | Sonnet (drafting stage) | agent.ts, new step |
| SCHEDULE | Brief time (after optimizer) | Sonnet (drafting stage) | morning-brief.ts, existing JIT path |
| REPLY (fallback) | Execution time (UDĚLAT click) | Sonnet (drafting stage) | execute/route.ts, existing JIT |
| Any (user edit) | On save | Haiku (draft_edit stage) | draft/route.ts PUT handler |
| SCHEDULE (full rewrite) | On explicit request | Sonnet (drafting stage) | New: async via QStash or direct |

### Draft lifecycle:

```
Step 5 (planning):
  → createAction() with intent_cs, original_intent_cs set
  → draft_body_text = null, original_draft_body = null

Step 5.5 (REPLY only):
  → generateFinalDraft() → draft_body_text, original_draft_body set
  → original_draft_body = draft_body_text (first write)

Brief time (SCHEDULE only):
  → optimizer runs → hold created with slot/time/location
  → generateFinalDraft() with slot context → draft_body_text set
  → original_draft_body = draft_body_text (first write)

User opens action card:
  → Draft already present (no wait for REPLY)
  → SCHEDULE draft present if optimizer ran

User edits + saves:
  → PUT /api/action/[id]/draft
  → Haiku gap-fill + grammar check (draft_edit stage)
  → draft_body_text updated
  → original_draft_body preserved (never overwritten)

User clicks UDĚLAT:
  → POST /api/action/[id]/execute
  → Uses draft_body_text (pre-generated)
  → Fallback: JIT generation if somehow null (logged as warning)

Reflection (step 7, next cycle):
  → Compares original_draft_body vs draft_body_text
  → Compares original_intent_cs vs intent_cs
  → Extracts observations about user edits
```

---

## 8. QStash Additions

### New schedules:

| Schedule | Frequency | Target | Created When |
|----------|-----------|--------|-------------|
| Belief audit (new users) | Monthly (1st, 3am) | /api/cron/belief-audit?userId=X | User setup |
| Belief audit (established) | Quarterly (1st of Q, 3am) | /api/cron/belief-audit?userId=X | Auto-switch at 3 months |

### New async jobs:

| Job | Trigger | Target | Model |
|-----|---------|--------|-------|
| Contradiction analysis | conflict_count >= 3 in reflection | /api/cron/contradiction-analysis | Sonnet → Opus |

### Monthly → quarterly switch:

In the belief audit endpoint itself:
```typescript
if (user.settings.belief_audit_created_at) {
  const monthsSinceCreation = differenceInMonths(
    new Date(),
    new Date(user.settings.belief_audit_created_at)
  )
  if (monthsSinceCreation >= 3 && isMonthlySchedule(user.settings.belief_audit_schedule_id)) {
    const newId = await switchBeliefAuditToQuarterly(
      userId, user.settings.belief_audit_schedule_id
    )
    await updateUserSettings(userId, { belief_audit_schedule_id: newId })
  }
}
```

---

## 9. Onboarding Changes

### User with existing history:

The existing bulk ingestion pipeline (`src/services/bulk-ingestion.ts`) has 5 phases. Add Phase 6:

**Phase 6: Journal Seeding**
- Input: all ingested conversations + their timeline entries
- Runs after Phase 5 (report)
- Single Sonnet call over full corpus
- Prompt: "Given this user's sent emails and conversations, extract behavioral patterns, communication style, and counterparty preferences"
- Output: seed journal entries across all scopes
- Many entries written directly as `type='belief'` (bulk history = sufficient confirmation)

**Delivery:**
- Seeded beliefs sent as belief email to user before Mila goes live
- User reviews: confirm (keep), correct (update content), reject (delete)
- This is the same belief email mechanism used ongoing — no new UI needed

### User with no history (forward-to-Mila):

New subject trigger in `src/services/ingestion.ts`:

```typescript
// Existing: "Mila:" prefix → command pipeline
// New: "Mila seed:" prefix → onboarding pipeline
if (isMilaSeedEmail(subject)) {
  return processSeedEmail(message, userId)
}
```

`processSeedEmail`:
1. Extract forwarded email body
2. Run through enrichment (existing)
3. Accumulate in a staging area (new column on user: `onboarding_seed_messages` jsonb array, or separate table)
4. After threshold (10-20 forwarded emails), trigger journal seeding (same as Phase 6 above)
5. Send belief email for review

**"Mila seed:" remains available permanently** — user can forward more examples anytime to refine Mila's understanding.

### Onboarding flow:

```
1. User connects Google OAuth
2. Bulk ingestion runs (existing)
3. Phase 6: journal seeding (new)
4. Belief email sent for review (new)
5. User confirms/corrects/rejects beliefs
6. Mila goes live with seeded journal
7. Ongoing: reflection refines beliefs each cycle
```

---

## 10. Implementation Order

Six phases. Each phase is independently deployable and testable.

### Phase 1: Journal Foundation
*No visible changes to user. Backend only.*

**Files created:**
- `src/lib/db/journal.ts`
- `src/services/reflection.ts`

**Files modified:**
- `src/lib/supabase/types.ts` — add JournalEntry types
- `src/config/ai-models.ts` — add reflection, draft_edit stages
- `src/lib/db/index.ts` — add journal barrel export

**Database:**
- Migration: create journal_entries table

**Tests:**
- Unit tests for journal CRUD
- Unit tests for reflection output processing (confirm/conflict/promote logic)
- Integration test for reflection AI call with mocked Haiku response

**Verification:** Run agent cycle, confirm step 0.5 and 7 execute without errors. Journal entries appear in DB after user interacts with action cards.

### Phase 2: Brief Redesign
*Visible change: briefs look different.*

**Files modified:**
- `src/services/morning-brief.ts` — AM/PM HTML restructure
- `src/lib/ai/mila-voice.ts` — updated generateBriefIntro signature

**New helpers in morning-brief.ts:**
- `enrichEventsWithSynopsis()`
- `getCoolingDeals()`
- `generateAMBriefEmailHtml()`
- `generatePMBriefEmailHtml()`

**Tests:**
- Snapshot tests for new HTML templates
- Test AM vs PM rendering with same data produces different output
- Test event + action interleaving logic
- Test gap detection in schedule

**Verification:** Send test briefs to user, compare AM vs PM. Verify events show synopses. Verify time-aware sectioning works.

### Phase 3: Draft Timing
*Visible change: REPLY action cards open instantly with draft ready.*

**Files modified:**
- `src/services/agent.ts` — add step 5.5
- `src/lib/db/actions.ts` — updateActionDraft preserves original
- `src/app/api/action/[id]/draft/route.ts` — Haiku on save
- `src/app/api/action/[id]/execute/route.ts` — fallback warning log

**Database:**
- Migration: add original_draft_body, original_intent_cs to action_proposals

**Files modified for ai-models:**
- `src/config/ai-models.ts` — add draft_edit stage (if not done in Phase 1)

**Tests:**
- Test that step 5.5 generates drafts for REPLY but not SCHEDULE
- Test that original_draft_body is preserved after user edits
- Test Haiku gap-fill prompt produces valid output
- Test execute fallback path still works

**Verification:** Run agent cycle, check REPLY actions have draft_body_text populated. Open action card — draft is instant. Edit and save — Haiku refines. Execute — pre-generated draft used.

### Phase 4: Learning Loop
*Visible change: Mila's proposals improve over time. Beliefs button in brief footer.*

**Files modified:**
- `src/services/agent.ts` — step 5 passes journal to planning
- `src/services/planning.ts` — accepts + filters journal entries, passes to prompt
- `src/lib/ai/gemini.ts` — proposeAction prompt includes journal context
- `src/services/morning-brief.ts` — beliefs footer button, volatile alert
- `src/lib/ai/mila-voice.ts` — generateBeliefEmailHtml(), updated generateBriefIntro

**Files created:**
- `src/app/api/beliefs/route.ts`
- `src/app/api/cron/contradiction-analysis/route.ts`

**Modified:**
- `src/lib/qstash/client.ts` — publishContradictionAnalysis()
- `src/config/ai-models.ts` — add contradiction_analysis, contradiction_escalation stages
- `src/lib/auth/tokens.ts` — belief email token generation

**Tests:**
- Test journal entries appear in proposeAction prompt
- Test belief email renders correctly
- Test contradiction analysis flow (mock Sonnet)
- Test volatile beliefs surface in brief

**Verification:** After several cycles with user interaction, check journal entries show observation → belief promotion. Check that planning output changes based on accumulated beliefs.

### Phase 5: Onboarding
*New user experience: Mila learns from history before going live.*

**Files modified:**
- `src/services/bulk-ingestion.ts` — add Phase 6 journal seeding
- `src/services/ingestion.ts` — add "Mila seed:" trigger

**Tests:**
- Test Phase 6 produces journal entries from conversation corpus
- Test seed email forwarding accumulates correctly
- Test belief email sent after threshold

**Verification:** Run bulk ingestion on test user, verify journal entries seeded. Forward 10 test emails with "Mila seed:" subject, verify beliefs generated.

### Phase 6: Opus Audit
*Lowest priority. Quality assurance layer.*

**Files created:**
- `src/app/api/cron/belief-audit/route.ts`

**Files modified:**
- `src/lib/qstash/client.ts` — createBeliefAuditSchedule, switchBeliefAuditToQuarterly
- `src/config/ai-models.ts` — add belief_audit stage

**Tests:**
- Test audit schedule creation on user setup
- Test monthly → quarterly switch at 3-month mark
- Test audit output processing

**Verification:** Manually trigger audit for test user, verify recommendations make sense.

---

## Appendix: Files Not Changed

These files are explicitly NOT modified by this spec:

- `src/services/threading.ts` — conversation assignment is unchanged
- `src/services/ingestion.ts` — email ingestion unchanged (except "Mila seed:" trigger in Phase 5)
- `src/services/calendar-ingestion.ts` — calendar sync unchanged
- `src/services/scheduling.ts` — schedule optimization unchanged
- `src/services/lead-tracking.ts` — lead detection unchanged (brief just reads its output differently)
- `src/lib/google/*` — Google API integrations unchanged
- `src/lib/crypto.ts` — encryption unchanged
- `src/components/action/ActionCard.tsx` — React component unchanged
- `src/components/action/action-card-template.ts` — action card HTML template unchanged (cards rendered the same, just placed differently in the brief layout)

---

## Appendix: Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Reflection prompt writes noisy observations | Medium | Strict "when in doubt, abstain" prompt rule + low default weight on observations |
| Bad belief promoted from coincidental observations | Medium | 3-observation threshold + recency_factor decay + user can delete via belief email |
| Brief generation time increases (more data fetching) | Low | Parallel fetches (Promise.allSettled). Events, journal, todos are all fast DB reads |
| Step 5.5 extends agent cycle timeout | Low | Cap at 3 batches (15 drafts). Remaining handled JIT |
| Opus API key tier doesn't support Opus | Low | Verify before Phase 6. Sonnet fallback works for all Opus stages |
| Journal entries accumulate without pruning | Low | Temporal entries expire. Deal entries stale on archive. Global entries overwritten. Monthly/quarterly audit catches the rest |
| User confused by "Co si Mila mysli" button | Low | Small, unobtrusive footer. Belief email is self-explanatory |
| Haiku gap-fill changes user's intended meaning | Low | Prompt explicitly forbids meaning changes. User sees result before sending |

---

## Appendix: New UserSettings Fields

```typescript
// Added to UserSettings interface in types.ts
last_reflection_at: string | null           // ISO timestamp of last reflection run
belief_audit_schedule_id: string | null      // QStash schedule ID
belief_audit_created_at: string | null       // when audit schedule was first created
onboarding_seed_count: number               // count of "Mila seed:" emails received (Phase 5)
```

All nullable, all default null. No breaking changes to existing settings.
