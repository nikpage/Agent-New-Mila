# Cost Estimate — Agent Pipeline Per User Per Month

## Assumptions

- **20 emails/day** (~10 inbound, ~10 outbound)
- **2 agent runs/day** (aligned with AM/PM briefs)
- **~10 new emails per run** (half the daily volume)
- **~5 actionable emails per run** (rest filtered/skipped)
- **~5 conversations updated per run**
- **1-2 SCHEDULE actions per day** (not every user, every day)
- **1-3 cooling/cold leads flagged per run**
- **30 days/month**

---

## 1. Dispatcher (New — "Anything New?" Check)

The dispatcher runs every 5-10 min globally, checking all users via Gmail `history.list`.

| Item | Per call | Calls/day/user | Monthly/user |
|------|----------|---------------|-------------|
| Gmail `history.list` | 2 quota units (free) | 144-288 (every 5-10 min) | **$0.00** |
| Supabase read (fetch user + historyId) | Included in plan | Same | **$0.00** |
| QStash publish (enqueue agent run) | $0.000001 | ~2 (only when new mail) | **$0.00** |

**Dispatcher cost per user/month: ~$0.00**

The dispatcher itself is one Vercel function invocation every 5-10 min (shared across all users). At 5000 users, each invocation checks 5000 users in batches — roughly 5-10 seconds of compute.

---

## 2. Gmail API (Per Agent Run)

| Operation | Calls/run | Quota units | Daily (×2 runs) |
|-----------|-----------|-------------|-----------------|
| `messages.list` (inbound) | 1 | 5 | 10 |
| `messages.list` (outbound) | 1 | 5 | 10 |
| `messages.get` (per new email) | ~10 | 50 | 100 |
| `users.getProfile` | 0-1 | 5 | 5 |
| `sendEmail` (brief) | 1 | 100 | 200 |

**Daily quota per user: ~325 units**
**Gmail API cost: $0.00** (free within standard quota; project limit ~20,000 units/sec)

At 5000 users: ~1.6M quota units/day. Well within the 1B/day project quota.

---

## 3. Google Calendar API (Per Agent Run)

| Operation | Calls/run | Daily |
|-----------|-----------|-------|
| `events.list` (upcoming) | 1 | 2 |
| `events.list` (invitations) | 1 | 2 |

**Calendar API cost: $0.00** (free)

---

## 4. AI — Gemini (Per Agent Run)

### Token estimates per call

| Stage | Model | Input tokens | Output tokens | Calls/run |
|-------|-------|-------------|--------------|-----------|
| filter | gemini-2.5-flash-lite | ~500 | ~50 | ~10 |
| classify | gemini-2.5-flash-lite | ~1,500 | ~200 | ~8 |
| enrichment | gemini-2.5-flash | ~3,500 | ~300 | ~10 |
| threading (topic + assign) | gemini-2.5-flash | ~2,000 | ~200 | ~2 |
| analysis (conversation summary) | gemini-2.5-flash | ~4,000 | ~500 | ~5 |
| planning (proposeAction + thinking) | gemini-2.5-flash | ~4,000 | ~1,000 + 8,192 thinking | ~5 |
| drafting (brief intro) | gemini-2.5-flash | ~1,000 | ~200 | 1 |
| drafting (lead follow-up) | gemini-2.5-flash | ~2,000 | ~300 | ~2 |
| drafting (scheduling intent) | gemini-2.5-flash | ~2,000 | ~300 | ~1 |
| embeddings | gemini-embedding-001 | ~500 | N/A | ~15 |

### Gemini pricing (as of early 2025 — verify current rates)

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Thinking (per 1M tokens) |
|-------|----------------------|----------------------|------------------------|
| gemini-2.5-flash-lite | $0.075 | $0.30 | N/A |
| gemini-2.5-flash | $0.15 | $0.60 | $0.70 (thinking) |
| gemini-embedding-001 | Free or ~$0.00015/1K chars | N/A | N/A |

**NOTE**: Gemini pricing changes frequently. These numbers are approximate — verify against current Google AI pricing page before making decisions.

### Per-run Gemini cost estimate

| Stage | Input cost | Output cost | Thinking cost | Total/run |
|-------|-----------|-------------|---------------|-----------|
| filter (10× flash-lite) | $0.000375 | $0.000150 | — | $0.000525 |
| classify (8× flash-lite) | $0.000900 | $0.000480 | — | $0.001380 |
| enrichment (10× flash) | $0.005250 | $0.001800 | — | $0.007050 |
| threading (2× flash) | $0.000600 | $0.000240 | — | $0.000840 |
| analysis (5× flash) | $0.003000 | $0.001500 | — | $0.004500 |
| planning (5× flash + thinking) | $0.003000 | $0.003000 | $0.028672 | $0.034672 |
| drafting (4× flash) | $0.001200 | $0.000660 | — | $0.001860 |
| embeddings (15×) | ~$0.000100 | — | — | $0.000100 |

**Gemini cost per run: ~$0.051**
**Gemini cost per day (2 runs): ~$0.102**
**Gemini cost per month: ~$3.06**

**Planning stage (proposeAction with thinking tokens) is ~68% of the total Gemini cost.**

---

## 5. AI — Anthropic Claude (Per Agent Run)

Claude is fallback for most stages but primary for reflection.

| Stage | Model | Calls/run | Input tokens | Output tokens |
|-------|-------|-----------|-------------|--------------|
| reflection | claude-haiku-4-5 | 1 | ~3,000 | ~500 |
| draft_edit (user-triggered) | claude-haiku-4-5 | ~0.5/day avg | ~2,000 | ~300 |
| Gemini fallback (occasional) | claude-haiku-4-5 or claude-sonnet-4-6 | ~0-2/run | varies | varies |

### Claude pricing

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|----------------------|
| claude-haiku-4-5 | $0.80 | $4.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |

**NOTE**: Verify against current Anthropic pricing page.

### Per-day Claude cost estimate

| Stage | Cost/call | Calls/day | Total/day |
|-------|-----------|-----------|-----------|
| reflection (haiku) | $0.0044 | 2 | $0.0088 |
| draft_edit (haiku, user-triggered) | $0.0028 | ~0.5 | $0.0014 |
| Fallback (assume 2 haiku/day) | $0.0044 | 2 | $0.0088 |

**Claude cost per day: ~$0.019**
**Claude cost per month: ~$0.57**

---

## 6. Google Maps API

Only fires when SCHEDULE actions involve a physical location.

| Operation | Price per 1K | Calls/day | Monthly cost |
|-----------|-------------|-----------|-------------|
| Geocoding | $5.00 | ~1 | $0.15 |
| Distance Matrix | $10.00 | ~2 | $0.60 |

**Maps cost per month: ~$0.75**

Most users won't trigger SCHEDULE every day. For a real estate agent (Mila's primary use case) this is realistic. For less meeting-heavy users, closer to $0.20/month.

---

## 7. Infrastructure

### Vercel

| Item | Free tier | Pro ($20/mo) | Notes |
|------|-----------|-------------|-------|
| Function invocations | 100K/mo | 1M/mo (then $0.60/1M) | |
| Function duration | 100 GB-hrs | 1000 GB-hrs (then $0.18/GB-hr) | |
| Bandwidth | 100 GB | 1 TB | |

Per-user function usage estimate (2 agent runs + 2 briefs + ~288 dispatcher checks shared):
- **Invocations**: ~4 dedicated + share of dispatcher = ~5/day = 150/month/user
- **Duration**: Agent run ~90s avg × 2/day × 1GB memory = ~5.4 GB-hrs/month/user

At 5000 users:
- 750K invocations/month — within Pro tier
- 27,000 GB-hrs/month — **this exceeds Pro tier by 26×**. Would cost ~$4,680/month in overage, or ~$0.94/user/month

**Vercel cost per user/month: ~$0.94** (at 5000 users on Pro plan)

### Supabase

| Plan | Price | Included |
|------|-------|---------|
| Pro | $25/mo | 8GB DB, 250K auth users, 500MB storage |

At 5000 users with moderate data, Pro plan likely sufficient. Compute add-ons may be needed for concurrent DB connections from 500+ simultaneous agent runs.

**Supabase cost per user/month: ~$0.01-0.05** (Pro plan shared across all users)

### QStash (Upstash)

| Item | Free tier | Pay-as-you-go |
|------|-----------|--------------|
| Messages | 500/day free | $1 per 100K messages |

Per user: 2 brief schedules + ~2 agent run enqueues/day = ~4 messages/day = 120/month
At 5000 users: 600K messages/month = ~$6/month total = **$0.001/user/month**

---

## Monthly Cost Summary Per User

| Category | Cost/user/month | % of total |
|----------|----------------|-----------|
| **Gemini AI** | **$3.06** | **56%** |
| **Vercel compute** | **$0.94** | **17%** |
| **Google Maps** | **$0.75** | **14%** |
| **Claude AI** | **$0.57** | **10%** |
| Gmail/Calendar API | $0.00 | 0% |
| QStash | ~$0.00 | 0% |
| Supabase (shared) | ~$0.03 | <1% |
| Dispatcher overhead | ~$0.00 | 0% |
| **TOTAL** | **~$5.35** | |

---

## Scaling Scenarios

| Users | AI cost | Vercel | Maps | Total/month | Per user |
|-------|---------|--------|------|-------------|----------|
| 10 | $36 | $20 (Pro base) | $8 | ~$64 | $6.40 |
| 100 | $363 | $114 | $75 | ~$552 | $5.52 |
| 500 | $1,815 | $490 | $375 | ~$2,680 | $5.36 |
| 1,000 | $3,630 | $960 | $750 | ~$5,340 | $5.34 |
| 5,000 | $18,150 | $4,700 | $3,750 | ~$26,600 | $5.32 |

AI dominates cost at every scale. Infrastructure is cheap relative to AI.

---

## Timeout Analysis

### Dispatcher (new endpoint)

| Step | Time for 5000 users |
|------|-------------------|
| Fetch all user IDs + historyIds from Supabase | ~200ms (single query) |
| Fetch OAuth tokens (batched) | ~500ms |
| Call `history.list` × 5000 (batches of 100, 50 parallel) | ~5-10s |
| Publish QStash messages for users with changes | ~1-2s |
| **Total** | **~7-13s** |

**IMPORTANT: The above timing assumes a bulk token fetch (see Required Refactors below).** The current `getAuthenticatedClient()` does one Supabase SELECT per user — at 5000 users that's 5000 sequential DB queries (~150 seconds), which would blow the timeout. The dispatcher must use a single `SELECT id, encrypted_google_tokens FROM users WHERE email_enabled = true` query instead.

The in-memory token cache in `auth.ts` won't help — it's per-serverless-instance and cold on every dispatcher invocation. The dispatcher must build its own token map within the request from the bulk query result.

### Agent run (existing, unchanged)

| Step | Typical time | Notes |
|------|-------------|-------|
| Steps 2/2.1/2.5 (parallel ingestion) | 30-60s | Gmail `messages.get` is serial (see below) |
| Steps 3-4 (threading) | 10-20s | Threading is intentionally serial to prevent duplicate conversations |
| Step 4.5 (summary rebuild) | 10-30s | 1 AI call per conversation |
| Step 5 (planning) | 15-30s | Bottleneck: proposeAction with thinkingBudget=8192 |
| Step 6 (lead tracking) | 5-15s | Concurrency 10 |
| **Total** | **70-155s (1-2.5 min)** | |

Fits within 5-minute Vercel timeout with margin. Idle users (no new mail) complete in 2-5 seconds. Heavy users (20+ emails, 10+ conversations) can push 90-180s.

**Gmail serial fetch bottleneck**: `fetchRecentEmails` in `gmail.ts` fetches each message individually in a `for` loop. 50 messages = 50 sequential HTTP calls at ~50ms each = 2.5 seconds of pure I/O. Not a blocker, but a future optimization target (Gmail supports HTTP batch requests of up to 100 sub-requests).

### Concurrent agent runs

If 500 out of 5000 users have new mail, QStash enqueues 500 agent runs.

**Vercel concurrency**: Pro plan allows 1000 concurrent functions per region (up to 3000 with support). 500 concurrent runs fits, but only just.

**Supabase connection pool is the real bottleneck**: Pro tier has ~200 direct connections via PgBouncer. 500 concurrent agent runs each holding a connection will saturate this. **QStash must rate-limit delivery** — e.g., 50-100 concurrent agent runs max. QStash supports this via delivery rate limiting.

**Memory**: Each agent invocation uses ~50-200MB (email bodies, AI responses, embeddings). Default 1024MB per function on Vercel Pro is sufficient.

---

## Cost Reduction Levers

1. **Planning thinking tokens** — 68% of AI cost. Reducing `thinkingBudget` from 8192 to 4096 would cut ~$0.86/user/month
2. **Skip agent run when no new mail** — The dispatcher already does this. Users with no activity cost $0 in AI per skipped run
3. **Batch enrichment** — Currently 1 AI call per email. Batching 3-5 emails into one call could cut enrichment costs 60-80%
4. **Reduce embedding calls** — Embeddings are no longer used for threading. Could be disabled entirely to save ~15 Gemini calls/run
5. **Maps caching** — Cache travel times for repeated routes (office → common meeting locations). Could cut Maps costs 50%+
6. **Run agent once/day instead of twice** — Halves AI cost. Brief can still run twice using cached data from the single agent run

---

## Scaling Constraints (Verified from Code)

### 1. Supabase connection pool
- Pro tier: ~200 direct connections via PgBouncer
- 500 concurrent agent runs = 500 connections = pool exhaustion
- **Mitigation**: QStash delivery rate limiting (50-100 concurrent max)

### 2. QStash schedule limits
- Current architecture: 2 QStash schedules per user (AM + PM brief)
- At 5000 users: 10,000 QStash schedules
- QStash free tier: 500 schedules. Paid tiers allow more, but 10,000 is aggressive
- Self-healing code (`ensureBriefSchedules`) already exists because schedules can disappear
- **Risk**: Must verify QStash plan limits before committing to per-user schedules at this scale
- **Alternative**: Replace per-user brief schedules with a single global cron + paging dispatcher (same pattern as the agent dispatcher)

### 3. In-memory token cache is per-instance
- `auth.ts` uses a module-level `Map` as cache — does NOT share across serverless instances
- 500 concurrent agent runs = 500 cold caches = 500 simultaneous Supabase queries just for token fetch
- **Mitigation**: Bulk token fetch in dispatcher; agent runs can keep the per-instance cache since each run only needs one user's tokens

### 4. Existing 100-user ceiling acknowledgment
- `morning-brief.ts` line 382: "At ~10s per user and concurrency=10, this handles ~100 users before the deadline"
- The current `sendAllMorningBriefs` processes users in batches of 10 within a single function — does not scale beyond ~100 users
- **Mitigation**: Brief sending needs the same dispatcher fan-out pattern as agent runs

### 5. Gmail messages.get is serial
- `fetchRecentEmails` fetches each message in a `for` loop — no parallelism
- 50 messages = 2.5s of serial I/O
- Not a blocker (within timeout), but a future optimization (Gmail HTTP batch API supports 100 sub-requests per batch)

### 6. Threading is intentionally serial
- `processTimelineEntries` runs entries one at a time to prevent duplicate conversation creation
- 20 unassigned entries = 20 sequential AI/DB operations = 20+ seconds
- This is correct behavior, not a bug — but it means heavy users take longer

---

## What Needs to Be Built

### New: Dispatcher endpoint (`/api/agent/dispatch`)
- Global QStash cron every 5-10 minutes
- Single bulk Supabase query: `SELECT id, encrypted_google_tokens, gmail_history_id FROM users WHERE email_enabled = true`
- Decrypt tokens in-memory, build per-user Gmail clients
- Call `history.list(startHistoryId)` per user in parallel batches of 100
- For users with changes: publish QStash message to `/api/agent/run` with rate limiting
- Update `last_checked_at` on every user checked
- Update `last_activity_at` on users with new mail
- At 5000+ users: split into paged QStash-chained invocations (500 users per page), same pattern as bulk ingestion worker

### Required refactor: Bulk token fetch
- Current `getAuthenticatedClient()` does per-user Supabase SELECT — unusable for dispatcher
- New function: `getAllUserTokens()` → single query, returns Map<userId, GoogleTokens>
- Dispatcher uses this instead of per-user `getAuthenticatedClient`
- Token refresh during dispatcher: if a token is near-expiry, either refresh inline or skip and let the agent run handle it

### Modified: Agent run (`/api/agent/run`)
- After successful run, save the latest `historyId` from Gmail to user record
- No other changes to the pipeline itself

### Modified: Brief sending (future, for >100 users)
- Replace `sendAllMorningBriefs` batch-in-one-function with dispatcher fan-out
- Single global cron → queries users due for brief → enqueues per-user QStash messages
- Replaces per-user QStash schedules (avoids 10,000 schedule limit)

### New: User record fields
- `gmail_history_id` (text) — last known Gmail historyId
- `last_checked_at` (timestamptz) — last dispatcher check
- `last_activity_at` (timestamptz) — last time new mail was found

### New: QStash schedule
- Global dispatcher schedule: `*/5 * * * *` or `*/10 * * * *`
- Created via `createDispatcherSchedule()` in qstash/client.ts

### Migration SQL (draft)
```sql
ALTER TABLE users ADD COLUMN gmail_history_id text;
ALTER TABLE users ADD COLUMN last_checked_at timestamptz;
ALTER TABLE users ADD COLUMN last_activity_at timestamptz;
```
