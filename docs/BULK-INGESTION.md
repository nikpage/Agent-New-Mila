# Bulk Ingestion & Backfill Report

## Bulk Ingestion (`src/services/bulk-ingestion.ts`)
Historical backfill — imports a user's email history and sets up Mila's understanding of their conversations.

**Route:** `POST /api/ingest/bulk` (API key auth, 5-min timeout). Streams NDJSON progress events: `started`, `progress`, `done`, `error`.

**4-phase pipeline:**
1. **Phase 1 — Fetch & Store:** Paginates through INBOX + SENT. Skips blocked senders, Gmail categories (PROMOTIONS, SOCIAL, etc.), duplicates. Runs `preFilterEmail()` AI + `enrichMessage()` AI per email. Tracks: `inboxFetched`, `sentFetched`, `skippedCategory`, `skippedBlocked`, `skippedPreFilter`, `skippedDuplicate`, `preFilterFailOpen`, `enriched`, `enrichmentFailed`, `stored`.
2. **Phase 2 — Thread:** Calls `processMessagesForThreading()` on all stored messages (chronological). Same threading logic as agent Step 4.
3. **Phase 3 — Backfill Report:** Generates and sends a "Welcome to Mila" summary email.
4. **Phase 4 — Enrich:** Retry pass — classifies and embeds any messages that failed enrichment during Phase 1. Runs after the report so the user gets their summary even if enrichment times out.

**Filtered senders** are tracked (email + count + reason) and passed to the backfill report for "Allow as Contact" links.

## Backfill Report (`src/services/backfill-report.ts`)
Generates a comprehensive HTML email sent from the user's Gmail to themselves. Sections:
- **Inbox health:** totals, inbound/outbound ratio
- **Filtered senders:** blocked/pre-filtered emails with "Allow as Contact" signed links
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
- **Orchestrator:** `src/app/api/ingest/bulk/route.ts` — QStash path (requires `QSTASH_TOKEN` + non-localhost `APP_BASE_URL`) or NDJSON fallback
- **Worker:** `src/app/api/ingest/bulk/worker/route.ts` — state machine handling all 4 phases (phase1_inbox, phase1_sent, phase2, phase3, phase4)
- **Batch fetch:** `fetchEmailsBatch()` in `src/lib/google/gmail.ts` — single-page Gmail fetch with `nextPageToken`
- **Batch process:** `processEmailBatch()` in `src/services/bulk-ingestion.ts` — dedup, filter, preFilter AI, store
- **QStash publish:** `publishBulkIngestStep()` in `src/lib/qstash/client.ts`
