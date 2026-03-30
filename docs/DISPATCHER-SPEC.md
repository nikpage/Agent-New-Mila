# Spec: Agent Dispatcher & Scaling Architecture

## Problem

The agent pipeline (`/api/agent/run`) accepts a single `userId` per request. There is no mechanism to trigger it for multiple users. `runAgentForAllUsers()` is an empty stub. The system cannot scale beyond a single manually-configured QStash schedule pointing at one user.

Additionally, `sendAllMorningBriefs()` processes users in batches of 10 within a single Vercel function, hitting a ceiling at ~100 users before the 300s timeout.

## Solution

A lightweight dispatcher that checks all users for new Gmail activity, then fans out agent runs only for users with changes. The same fan-out pattern replaces the in-process brief sending loop.

---

## Current State (What Exists)

### Agent triggering
- `POST /api/agent/run` — accepts `{ userId }`, calls `runAgentForUser(userId)`, maxDuration=300s
- `runAgentForAllUsers()` in agent.ts — empty stub, returns empty Map
- No QStash schedule creation code for agent runs (manual console setup only)

### Email ingestion
- `ingestEmailsForUser(userId)` calls `fetchUnreadEmails(userId, 50)`
- `fetchUnreadEmails` calls `fetchRecentEmails(userId, { maxResults: 50, labelIds: ['INBOX'] })`
- No date cursor, no historyId — "newness" is determined by `messageExists(userId, email.id)` DB dedup
- Dedup works but is wasteful: fetches up to 50 emails from Gmail on every run, then checks each against DB

### Brief sending
- `sendAllMorningBriefs(briefType, windowMinutes)` — gets all due users, processes in batches of 10 in-process
- `BRIEF_CONCURRENCY = 10` — ceiling of ~100 users per 300s function
- Per-user QStash schedules (2 per user) call `/api/cron/morning-brief?userId=X` directly — bypasses `sendAllMorningBriefs` entirely
- At 5000 users: 10,000 QStash schedules (may exceed plan limits)

### Token fetching
- `getUsersWithEmailEnabled()` already returns `select('*')` including `encrypted_google_tokens` and `google_oauth_tokens`
- `getAuthenticatedClient(userId)` has per-user DB SELECT + in-memory cache (per-instance, not shared)
- Dispatcher can use the bulk result from `getUsersWithEmailEnabled()` directly — no per-user DB query needed

---

## New Architecture

### 1. Dispatcher Endpoint: `POST /api/agent/dispatch`

**Trigger**: Global QStash schedule, `*/5 * * * *` (every 5 minutes)

**Auth**: CRON_SECRET (same as other cron endpoints)

**maxDuration**: 300s

**Flow**:

```
1. Fetch all active users (single Supabase query)
   - getUsersWithEmailEnabled() — already returns tokens
   - Filter to users with valid Google credentials

2. For each user, call Gmail history.list(startHistoryId)
   - Parallel batches of 100
   - Each call: ~50-100ms
   - 5000 users = ~50 batches = ~5-10 seconds

3. For users with changes (history.list returns new events):
   - Publish QStash message to POST /api/agent/run with { userId }
   - Update user.last_activity_at = now()

4. For ALL checked users:
   - Update user.last_checked_at = now()

5. For users where history.list returned a new historyId:
   - Do NOT update gmail_history_id here — agent run does that after successful processing
```

**Paging for >1000 users**: If user count exceeds 1000, the dispatcher processes the first 1000 and publishes a QStash message to itself with `{ offset: 1000 }` to continue. Same chaining pattern as bulk ingestion worker.

**Token handling in dispatcher**: Decrypt tokens from the bulk query result in-memory. If a token is expired and needs refresh, skip that user — the agent run's `getAuthenticatedClient` handles refresh. The dispatcher only needs read-only Gmail access for `history.list`.

**Error handling**: `Promise.allSettled` per batch. Users whose `history.list` fails (revoked tokens, network errors) are logged and skipped. Sentry alert if >10% of users fail.

### 2. Modified Agent Run: `POST /api/agent/run`

**Changes** (minimal):

After successful ingestion (Steps 2/2.1 complete), save the latest historyId from Gmail:

```
- Call gmail.users.getProfile or gmail.users.history.list to get current historyId
- updateUserSettings(userId, { gmail_history_id: latestHistoryId })
```

This is the ONLY place `gmail_history_id` is written. The dispatcher reads it; the agent writes it.

**First run bootstrap**: If `gmail_history_id` is null (new user, or existing user before migration), the dispatcher treats this user as "has changes" and enqueues an agent run. The agent run then stores the historyId for future checks.

### 3. Brief Sending Fan-Out (for >100 users)

Replace `sendAllMorningBriefs` in-process loop with dispatcher pattern:

**New endpoint**: `POST /api/cron/brief-dispatch`

**Trigger**: Global QStash schedule, runs at fixed times (e.g., every 15 minutes) instead of per-user schedules

**Flow**:
```
1. getUsersDueBrief(briefType, windowMinutes) — already exists
2. For each due user: publish QStash message to GET /api/cron/morning-brief?userId=X
3. QStash handles delivery with rate limiting
```

This replaces 10,000 per-user QStash schedules with 1 global schedule + on-demand QStash messages.

**Migration path**: Keep per-user schedules working for existing users. New users get the fan-out path. Eventually migrate all users and delete per-user schedules.

### 4. QStash Delivery Rate Limiting

All fan-out QStash publishes must respect Supabase connection limits.

**Agent runs**: Publish with QStash delay staggering — e.g., spread 500 messages across 60 seconds so no more than ~50 arrive concurrently at Vercel.

QStash supports `delay` parameter on `publishJSON`:
```
publishJSON({ url, body, delay: i * 200 }) // 200ms apart = 5/sec = 50 concurrent at 10s avg runtime
```

Alternatively, QStash supports `rate` on schedules — need to verify if it applies to individual publishes.

### 5. New User Record Fields

```sql
ALTER TABLE users ADD COLUMN gmail_history_id text;
ALTER TABLE users ADD COLUMN last_checked_at timestamptz;
ALTER TABLE users ADD COLUMN last_activity_at timestamptz;
```

| Field | Written by | Read by | Purpose |
|-------|-----------|---------|---------|
| gmail_history_id | Agent run (after successful ingestion) | Dispatcher (to call history.list) | Gmail incremental sync cursor |
| last_checked_at | Dispatcher (every check) | Monitoring/alerting | Confirms polling is healthy |
| last_activity_at | Dispatcher (when new mail found) | Monitoring/analytics | Shows actual activity frequency |

---

## Gmail history.list Details

**API call**: `gmail.users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'] })`

**Cost**: 2 quota units (cheapest Gmail read operation)

**Response**: Returns list of history records with message IDs added since `startHistoryId`. If empty → no new mail.

**Edge cases**:
- `startHistoryId` too old (>~1 week): returns 404. Dispatcher treats as "has changes" and enqueues agent run. Agent run resets historyId.
- Account has no history: returns empty. Dispatcher skips.
- Token expired: `history.list` fails with 401. Dispatcher skips user (agent run handles token refresh).

**What counts as "change"**: `messageAdded` includes received emails, sent emails, and drafts. This covers both inbound and outbound ingestion triggers.

---

## Scaling Characteristics

| Users | Dispatcher time | Agent runs enqueued (10% active) | Concurrent agent runs (staggered) | Supabase connections |
|-------|----------------|--------------------------------|----------------------------------|---------------------|
| 100 | ~2s | ~10 | ~10 | ~10 |
| 500 | ~3s | ~50 | ~50 | ~50 |
| 1,000 | ~5s | ~100 | ~50 (staggered) | ~50 |
| 5,000 | ~10s (1 page) | ~500 | ~50 (staggered) | ~50 |
| 10,000 | ~20s (2 pages) | ~1000 | ~50 (staggered) | ~50 |

Supabase connections stay at ~50 regardless of user count because QStash delivery is rate-limited.

---

## Files to Create/Modify

### New files
| File | Purpose |
|------|---------|
| `src/app/api/agent/dispatch/route.ts` | Dispatcher endpoint |
| `src/app/api/cron/brief-dispatch/route.ts` | Brief fan-out endpoint (phase 2) |

### Modified files
| File | Change |
|------|--------|
| `src/lib/google/gmail.ts` | Add `checkForNewMail(auth, historyId)` function |
| `src/services/agent.ts` | Save historyId after ingestion; remove `runAgentForAllUsers` stub |
| `src/lib/qstash/client.ts` | Add `createDispatcherSchedule()`, `publishAgentRun(userId, delay?)` |
| `src/lib/db/users.ts` | Add `updateUserHistoryId()`, `updateUserLastChecked()`, `updateUserLastActivity()` |

### Migration
| File | Change |
|------|--------|
| `docs/SCHEMA.md` | Add 3 new columns to users table |
| Supabase migration | `ALTER TABLE users ADD COLUMN gmail_history_id text, ADD COLUMN last_checked_at timestamptz, ADD COLUMN last_activity_at timestamptz;` |

---

## Implementation Order

1. **Migration**: Add 3 columns to users table
2. **gmail.ts**: Add `checkForNewMail()` function
3. **users.ts**: Add update functions for new fields
4. **agent.ts**: Save historyId after successful ingestion
5. **qstash/client.ts**: Add dispatcher schedule + agent run publish functions
6. **dispatch/route.ts**: Build dispatcher endpoint
7. **Test**: Run with 1 user, verify historyId is stored and dispatcher detects new mail
8. **QStash**: Create global dispatcher schedule
9. **Phase 2**: Brief fan-out endpoint (when approaching 100 users)

---

## What This Does NOT Change

- The agent pipeline itself (Steps 1-7) — unchanged
- Per-user agent run runtime — unchanged
- Email dedup via `messageExists()` — still works as safety net
- `fetchUnreadEmails` — still fetches INBOX emails (agent doesn't use historyId for fetching, only dispatcher uses it for checking)
- Action proposal, threading, planning, lead tracking — all unchanged
- Brief content and rendering — unchanged
- Instant notification polling — unchanged (already global)

---

## Open Questions

1. **QStash delivery rate limiting**: Does QStash support a `delay` parameter on `publishJSON`? Or do we need a different mechanism to stagger delivery? Need to verify.
2. **QStash schedule limit**: What is the actual limit on the current Upstash plan? This determines when brief fan-out becomes mandatory.
3. **Supabase connection pooling**: Current plan's PgBouncer pool size? This determines the max concurrent agent runs.
4. **Gmail history.list with service account vs OAuth**: The dispatcher needs per-user OAuth tokens. Can we use a single service account for read-only history checks? Likely no for consumer Gmail, but worth checking for Workspace accounts.
