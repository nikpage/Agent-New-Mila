# Bulk Ingestion & Backfill Report

## Bulk Ingestion (`src/services/bulk-ingestion.ts`)
Historical backfill — imports a user's email history and sets up Mila's understanding of their conversations.

**Route:** `POST /api/ingest/bulk` (API key auth, 5-min timeout). Streams NDJSON progress events: `started`, `progress`, `done`, `error`.

**5-phase pipeline:**
1. **Phase 1 — Fetch & Store:** Fetches INBOX + SENT in parallel. Skips blocked senders, Gmail categories (PROMOTIONS, SOCIAL, etc.), duplicates. Runs `filterEmail()` AI per email. Stores with `tag_primary='bulk_import'`. 20 emails processed in parallel. Tracks: `inboxFetched`, `sentFetched`, `skippedCategory`, `skippedBlocked`, `skippedFilter`, `skippedDuplicate`, `filterFailOpen`, `stored`.
2. **Phase 2 — Enrich + Embed:** Queries `tag_primary='bulk_import' AND enriched_text IS NULL`. Runs `enrichMessage()` + `generateMessageEmbedding()` per message, 20 in parallel. Tracks: `enriched`, `enrichmentFailed`, `embedded`, `embeddingFailed`.
3. **Phase 3 — Thread:** Calls `processMessagesForThreading()` on all unprocessed messages (chronological). Same threading logic as agent Step 4. Embeddings from Phase 2 enable semantic matching.
4. **Phase 4 — Classify:** Queries `tag_primary='bulk_import'`. Runs `classifyEmail()` per message, 20 in parallel. Updates `tag_primary` to real category (replaces `bulk_import`). Tracks: `classified`, `classifyFailed`.
5. **Phase 5 — Backfill Report:** Generates and sends a "Welcome to Mila" summary email. Runs last so all data is complete.

**`tag_primary='bulk_import'` flow:** Phase 1 sets it → Phase 2 enriches (tag unchanged) → Phase 3 threads (tag unchanged) → Phase 4 classifies (tag changes to real category) → Phase 5 reports on complete data.

**Filtered senders** are tracked (email + count + reason) and passed to the backfill report for "Allow as Contact" links.

## Backfill Report (`src/services/backfill-report.ts`)
Generates a comprehensive HTML email sent from the user's Gmail to themselves. Sections:
- **Inbox health:** totals, inbound/outbound ratio
- **Filtered senders:** blocked/filtered emails with "Allow as Contact" signed links
- **Counterparties:** discovered contacts with message counts, deal stage, "Blacklist" links
- **Conversations:** threads with summary, CP names, lead status, "Add to Mila" links
- **Unanswered inbound:** emails from last 7 days with no outbound reply
- **Calendar:** upcoming events (next 2 weeks)
- **Leads:** cooling/cold/dead lead alerts

## Backfill Action Handler (`src/app/api/backfill/action/route.ts`)
Handles signed GET links from the report email. Operations:
- `allow` — creates CP from a previously-filtered sender email
- `blacklist` — blacklists an existing CP
- `add` — generates action proposals for a conversation (enters Mila process)
- `setrole` — sets a CP's role (e.g., `buyer`, `seller`)

Authentication via HMAC-signed backfill tokens (`generateBackfillToken`/`validateBackfillToken` in `src/lib/auth/tokens.ts`). All operations are idempotent.

## QStash Worker Chaining (Vercel deployment)

### Problem
Bulk historical email ingestion (500+ emails) exceeds Vercel's 300-second function timeout when running as a single request.

### Solution
When `QSTASH_TOKEN` is set **and** `APP_BASE_URL` points to a public address (not localhost/127.0.0.1/[::1]), `/api/ingest/bulk` splits the work into chained QStash messages. Each step runs within the 300s timeout. If `QSTASH_TOKEN` is missing or `APP_BASE_URL` is empty/localhost, falls back to synchronous NDJSON streaming (QStash can't reach loopback addresses).

### Architecture
```
POST /api/ingest/bulk (orchestrator)
  ├─ Validates input, resolves user email, purges user-as-CP
  ├─ Publishes first QStash step → returns 202 immediately
  │
  ▼ QStash worker chain (/api/ingest/bulk/worker)
  │
  ├─ phase1_inbox    ─► fetch 50 inbox emails, filter+store (20 parallel), chain next page
  │   └─ repeats until maxTotal reached or no more pages
  ├─ phase1_sent     ─► fetch 50 sent emails, filter+store (20 parallel), chain next page
  │   └─ repeats until maxTotal reached or no more pages
  ├─ phase2_enrich   ─► enrich + embed all unenriched bulk_import messages (20 parallel)
  ├─ phase3_thread   ─► thread all unprocessed messages into conversations
  ├─ phase4_classify ─► classify all bulk_import messages (20 parallel)
  └─ phase5_report   ─► generate & send backfill report email to user
```

### Key Details
- **Batch size:** 50 emails per QStash hop (Phase 1)
- **Concurrency:** 20 emails processed in parallel within each hop (Phases 1, 2, 4)
- **Budget:** 500 emails ≈ 14 QStash calls (10 for Phase 1 + 1 each for Phases 2–5)
- **State passing:** Job state (stats, filteredSenders, pageToken) is passed in the QStash message body between hops
- **Auth:** Worker endpoint uses `CRON_SECRET` Bearer token (same as morning-brief)
- **Orchestrator returns:** `{ started: true, mode: "queued", qstashMessageId }` with HTTP 202
- **Idempotency:** Phase 1 dedup via `messageExists()` prevents double-storing on QStash retry

### Implementation
- **Orchestrator:** `src/app/api/ingest/bulk/route.ts` — QStash path (requires `QSTASH_TOKEN` + non-localhost `APP_BASE_URL`) or NDJSON fallback
- **Worker:** `src/app/api/ingest/bulk/worker/route.ts` — state machine handling all 5 phases (phase1_inbox, phase1_sent, phase2_enrich, phase3_thread, phase4_classify, phase5_report)
- **Batch fetch:** `fetchEmailsBatch()` in `src/lib/google/gmail.ts` — single-page Gmail fetch with `nextPageToken`
- **Batch process:** `processEmailBatch()` in `src/services/bulk-ingestion.ts` — dedup, filter AI, store (20 parallel)
- **QStash publish:** `publishBulkIngestStep()` in `src/lib/qstash/client.ts`
