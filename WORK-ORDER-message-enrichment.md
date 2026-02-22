# Work Order: Message Enrichment & Conversation Context Redesign

## Problem

The current embedding system is broken in practice:
- Per-message embeddings are saved but never read (dead cost)
- Conversation embeddings are built from a one-line AI summary — thin signal, weak matching
- Planning AI gets raw truncated message text — no extracted facts, no structure
- No cross-channel threading capability (WhatsApp message can't find its email conversation)
- Text cleaning is Gmail-only — MS Exchange and future channels aren't handled
- Short messages (WhatsApp) produce thin summaries which produce thin vectors which produce bad matches

## Principles

- Messages live in channels. Conversations cross channels. That's the whole point.
- Enrichment prompt is a guide, not a schema. AI fills what's there, skips what isn't. No invented fluff.
- Non-deal messages (personal, admin, legal) are first-class — no forcing everything into a deal-stage box.
- No steps for the sake of steps. Every piece of work must benefit the user or the app.

---

## 1. Kill dead message embeddings

**What:** Remove the two `saveMessageEmbedding(messageId, embedding)` calls in `src/services/ingestion.ts` (inbound ~line 267, outbound ~line 382). These embed raw email body text into `message_embeddings` and nothing ever reads them.

**Why:** Pure waste — one Gemini API call per message, writes to DB, never queried.

**Don't:** Drop the `message_embeddings` table yet. It gets repurposed in step 3.

---

## 2. Channel-aware message cleaning

**What:** Refactor `cleanEmailText()` in `src/lib/embeddings/generate.ts` into `cleanMessageText(text, channel)`.

- `email/gmail`: Current 9-regex pipeline (already works)
- `email/exchange`: Add Exchange-specific patterns — Outlook signatures, disclaimer blocks, meeting invite boilerplate, `<https://aka.ms/...>` links, `EXTERNAL EMAIL` banners
- `whatsapp`: Minimal — strip system messages ("Messages and calls are end-to-end encrypted"), forwarded labels, no other cleaning needed (WA messages are already clean)
- Unknown/future channels: Apply only universal cleaning (collapse whitespace, strip tracking pixels)

**Why:** Enrichment quality depends on clean input. Exchange emails have different noise patterns than Gmail. Cleaning must happen before enrichment, not after.

**Where:** Same file, or move to `src/lib/text/clean.ts` if it gets big enough to warrant its own module.

---

## 3. Per-message enrichment

**What:** New AI stage `enrichment` that runs on each message after ingestion and cleaning.

### Prompt design (guidance, not schema)

```
Extract key information from this message. Use the following as guidance
for what to look for, but only include what's actually present.
Do not invent or guess. Leave out anything not clearly supported by the text.

- Who's involved (all parties in the conversation, and who's in focus now)
- What property or subject matter, if any
- What kind of message (event, request, info, offer, personal, admin, legal...)
- If deal-related: stage, key numbers (price, area, dates), commitments made
- If personal/admin: what it's about, any time sensitivity, any action needed
- What this message actually says or asks (the core intent)
- Relevant conversation history context

Channel: {channel}
Direction: {inbound/outbound}
```

The output is free-form structured text — readable by humans and useful to downstream AI. Not JSON. Not fixed fields.

### Storage

- Save enriched text on the message row. New column `enriched_text` on `messages` table (text, nullable). Existing messages have NULL — enriched on next processing or backfill.
- Embed the enriched text (not the raw body). Save to `message_embeddings` table (repurposing the existing table, same schema).

### AI model

- Add `enrichment` stage to `src/config/ai-models.ts` fallback chain
- Lightweight model preferred (flash-lite or flash) — this runs per-message, cost matters
- Feed it: cleaned message text + conversation context (last few enriched messages if available, for continuity)

### Pipeline integration

- Runs in `src/services/ingestion.ts` after message creation, after cleaning, before threading
- Replaces the current dead `saveMessageEmbedding` calls
- Errors caught silently (same as current) — enrichment failure doesn't block ingestion

---

## 4. Conversation summary redesign

**What:** Rebuild `rebuildConversationSummary()` in `src/services/threading.ts` to use enriched messages.

### Input

- Last N enriched messages (`enriched_text` from message rows), not raw text
- N is adaptive: enough messages to reach ~1500+ chars of enriched content, or all messages if conversation is short
- If some messages lack enrichment (old data), fall back to `cleaned_text`

### Summary prompt (loose template)

The conversation summary prompt guides the AI to produce a useful snapshot. Prompt-based, not schema-based:

```
Summarize this conversation based on the enriched message extracts below.
Include only what's supported by the messages. Do not invent.

Cover what's relevant:
- What this conversation is about (property, matter, topic)
- Current state and where things stand
- Who's involved and their roles
- If deal-related: stage, key numbers, outstanding commitments
- If personal/admin: what's needed, any deadlines
- What needs to happen next (concrete, not vague)
- Any risks or blockers
```

### Storage

- `summary_text`: The full summary (replaces current one-liner)
- `summary_json`: Structured version for programmatic access (existing column, keep for planning AI)
- Conversation embedding generated from `summary_text` (richer signal than before)

### Trigger

- Same as current: rebuilds after N new messages (currently 5, via `messages_since_rebuild`)
- First message in a new conversation gets a minimal summary from its own enrichment

---

## 5. Cross-channel threading with enriched embeddings

**What:** Update `assignToConversation()` in `src/services/threading.ts` to use enriched message embeddings for matching.

### Current flow
1. Gmail thread ID match (exact) → done
2. Conversation embedding similarity → thresholds (0.78 auto-join, 0.55-0.78 AI tiebreak)
3. New conversation

### New flow
1. External thread ID match (Gmail thread ID, Exchange conversation ID, WA phone thread) → done
2. **Enriched message embedding** vs conversation embeddings → same thresholds
3. AI tiebreak in gray zone (same as current, but with enriched context)
4. New conversation

**Why this matters:** A WhatsApp message "hey, about that flat on Vinohradská — Thursday works for the viewing" has no Gmail thread ID. But its enriched embedding (property: Vinohradská, event: viewing, date: Thursday) will match the email conversation about that property. This is the core cross-channel capability.

### Exchange threading

- MS Exchange provides `conversationId` — use as `external_thread_id` (same pattern as Gmail thread ID)
- When conversation ID doesn't match (forwarded threads, new chains about same deal), fall back to enriched embedding matching

---

## 6. Planning context upgrade

**What:** Update `src/services/planning.ts` to feed enriched messages to `proposeAction`.

### Current
- Fetches 5 messages, passes last 3 to AI, truncates each to 500 chars raw text

### New
- Fetches last N messages with `enriched_text`
- Passes enriched text (not raw) to proposeAction
- Adaptive count: enough messages to reach ~2000 chars of enriched content, minimum 3, maximum 10
- Short enrichments (WhatsApp) naturally include more messages; long enrichments (email) include fewer

**Why:** The planning AI gets pre-extracted facts instead of trying to parse raw email text with signatures and quoted replies. Better proposals, better dollar_value estimates, better deal_type classification.

---

## 7. Thin conversation handling

**What:** When a new conversation starts too thin for meaningful context, generate a ToDo asking the user to fill in details.

### Trigger
- New conversation created with first message < 100 chars of enriched text
- AND no property/subject/deal info extracted by enrichment
- AND conversation has only 1 message

### Action
- Create a ToDo (via existing `src/lib/db/todos.ts` → `createTodo`) linked to the conversation
- Description: "New conversation with {CP name} — not enough context to work with. What's this about?"
- Due date: next brief (morning or afternoon, whichever is sooner)
- Shows up in the user's brief for them to fill in

### Don't
- Don't auto-generate ToDos for every short message — only for new conversations where the AI truly can't extract anything useful
- Don't block the conversation from being created — just flag it

---

## DB migration

```sql
-- Add enriched_text column to messages
ALTER TABLE messages ADD COLUMN enriched_text text;

-- Index for finding messages needing enrichment (backfill)
CREATE INDEX idx_messages_enriched_null
  ON messages (user_id, created_at)
  WHERE enriched_text IS NULL;
```

No other schema changes. `message_embeddings` table stays as-is (repurposed). `conversation_threads` columns stay as-is (`summary_text`, `summary_json`, `embedding`).

---

## Order of operations

1. **DB migration** — add `enriched_text` column
2. **Channel-aware cleaning** (#2) — prerequisite for everything
3. **Per-message enrichment** (#3) — the core new capability
4. **Kill dead embeddings** (#1) — replaced by enrichment embeddings in #3
5. **Conversation summary redesign** (#4) — depends on enriched messages existing
6. **Cross-channel threading** (#5) — depends on enriched embeddings
7. **Planning context upgrade** (#6) — depends on enriched messages
8. **Thin conversation ToDos** (#7) — depends on enrichment being able to say "nothing useful here"

Steps 2-4 can ship together as one unit. Steps 5-6 together. Step 7-8 together.

---

## What this does NOT cover

- MS Exchange ingestion (separate work — this assumes messages arrive in the `messages` table regardless of source)
- WhatsApp daemon changes (daemon writes messages to DB, this work processes them after)
- Backfilling enrichment for existing messages (can be a background job, not blocking)
- Changes to morning brief format
- Changes to action execution / draft generation
