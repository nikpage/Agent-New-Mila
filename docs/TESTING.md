# Testing Reference

**Framework:** Vitest 4 with `@/*` path aliases (`vitest.config.ts`). Tests are co-located next to source files (`foo.ts` → `foo.test.ts`).

### Philosophy: Mock-Only-AI

Integration and pipeline tests mock **only external boundaries** — AI calls (Gemini, Anthropic), Google APIs (Gmail, Calendar, Maps, Auth), and embedding generation. Everything else runs for real:

- **Real DB** — Supabase CRUD, scoring, token generation, data integrity
- **Real config** — `calculatePriorityScore`, `getAISystemPrompt`, settings parsing
- **Real auth tokens** — HMAC round-trip via `generateActionToken`/`validateActionToken`
- **Real text cleaning** — `cleanMessageText`, `cleanEmailText` (uses `importOriginal()`)
- **Real HTML templates** — morning brief email generation

This ensures tests catch real regressions, not just mock return values.

### Setup

- **`vitest.setup.ts`** — Loads `.env.local` for DB credentials (uses Node built-ins, no dotenv dependency). Shell env vars take precedence.
- **`vitest.config.ts`** — `setupFiles: ['./vitest.setup.ts']` ensures env is loaded before any test.
- **`src/__tests__/helpers/test-db.ts`** — Real Supabase test utilities: `setupTestUser()`, `createTestCP()`, `createTestConversation()`, `createTestMessage()`, `createTestAction()`, `cleanupTestData()`, `getTestActions()`, `getTestMessages()`, `getTestConversations()`. Cleanup uses FK-safe cascade delete mirroring GDPR `deleteAllUserData` order.

### Run
```bash
npm test                                           # Unit + integration (263 tests with DB, 233 without)
npm run test:watch                                 # Watch mode (re-runs on save)
npm run test:coverage                              # With v8 coverage report
SMOKE_TEST=1 npm test -- src/__tests__/smoke.test.ts  # + 10 smoke tests (needs running server)
E2E_TEST=1 npm test -- src/__tests__/e2e.test.ts      # + 12 e2e tests (100% live, costs money)
```

### Test Tiers (296 total: 252 unit + 22 integration + 10 smoke + 12 e2e)

#### Tier 1: Unit Tests (252 tests, always run)

No DB, no server, no env vars needed. Pure function verification.

##### Route Protection (37 tests)
**File:** `src/app/api/__tests__/route-protection.test.ts`

Every API route rejects unauthenticated/bad requests. Catches: removed auth checks, changed HTTP methods, broken request parsing.

- API key routes: `/api/agent/run`, `/api/gdpr/delete`, `/api/gdpr/export`, `/api/ingest`, `/api/ingest/bulk`, `/api/whatsapp/status`
- Cron routes: `/api/cron/morning-brief` (GET + POST), `/api/cron/instant-notify` (GET + POST + bad token), `/api/ingest/bulk/worker` (no token + bad token)
- Action token routes: `/api/action/[id]`, `/api/action/[id]/execute`, `/api/action/[id]/draft`, `/api/action/[id]/blacklist`, `/api/action/[id]/todo`
- Superadmin: `/api/superadmin/stats`
- Trigger pixel: `/api/trigger/ingest` — verifies it returns GIF but does NOT run agent with bad sig
- Backfill: `/api/backfill/action` — rejects missing params and bad signatures
- Auth: `/api/auth/connect` (email validation), `/api/auth/callback` (state validation)

##### Behavior Pinning (74 tests)

**Catches unauthorized changes to scoring, thresholds, defaults, or business logic.**

| File | Tests | What it pins |
|------|-------|-------------|
| `src/lib/supabase/defaults.test.ts` | 48 | Every single field in `DEFAULT_USER_SETTINGS` — exact values. Also pins field count (58) to catch added/removed fields. |
| `src/services/lead-tracking.test.ts` | 12 | Lead thresholds (2/5/14 days), boost multipliers (1.5x/2.5x/3.75x), urgency mappings, threshold ordering |
| `src/services/scheduling.test.ts` | 9 | Meeting duration, buffer, working hours, working days, timezone, travel mode defaults |
| `src/services/morning-brief.test.ts` | 6 | Brief times (08:00/13:00), concurrency limit (10), max actions per brief (10), instant notify threshold (79), instant notify concurrency (10) |

##### Logic Tests (127 tests)

| Source file | Test file | What's tested |
|-------------|-----------|---------------|
| `src/lib/auth/tokens.ts` | `tokens.test.ts` | 20 tests — HMAC round-trip, expiry, tampering, missing secret, malformed input. **Protects every approve/reject button in brief emails.** |
| `src/services/agent.ts` | `agent.test.ts` | 12 tests — Lock acquire/release/fallback, user-not-found, no-credentials, fault isolation (`Promise.allSettled` not `Promise.all`) |
| `src/services/planning.ts` | `planning.test.ts` | 11 tests — `validateDealType`: valid/invalid/hallucinated values, `selectOfferMultiplier`: seller/buyer/null role selection, `VALID_DEAL_TYPES`/`VALID_CP_ROLES` pinning, seller vs buyer priority score difference |
| `src/lib/db/actions.ts` | `actions.test.ts` | 17 tests — `calculatePriorityScore` log-scale formula: zero-safety fallbacks, quadratic `daysIgnored` growth, offerMultiplier before log, anchor mapping (low→2, high→13), no clamping, custom anchors, edge cases, urgent-small-beats-routine-big |
| `src/services/ingestion.ts` | `ingestion.test.ts` | 8 tests — `isBlockedSender`: exact/prefix/domain/subaddress matching, false-positive prevention (`mynotifications` ≠ `notifications`) |
| `src/config/client.ts` | `client.test.ts` | 10 tests — `containsHighValueSignals` + `isPersonalEvent`: keyword matching, case-insensitivity, empty inputs, empty keyword lists |
| `src/lib/db/counterparties.ts` | `counterparties.test.ts` | 11 tests — `isSameGmailAddress`: dot/case-insensitive, domain dots, whitespace trimming; `normalizeGmailAddress`: lowercasing, dot stripping, idempotency, missing `@` |
| `src/lib/embeddings/generate.ts` | `generate.test.ts` | 30 tests — `cleanEmailText` (13 original), `cleanMessageText` channel-aware: Exchange (EXTERNAL banners, Outlook headers, aka.ms, Get Outlook), WhatsApp (system msgs, forwarded labels, no false stripping), backward-compatible alias, unknown channel fallback |
| `src/lib/whatsapp/types.ts` | `types.test.ts` | 6 tests — `normalizePhoneNumber`, `phoneToThreadId`: separator stripping, `+` prefix, thread ID format |
| `src/lib/db/gdpr.ts` | `gdpr.test.ts` | 4 tests — `writeAuditLog` never-throw contract, `deleteAllUserData` FK-safe ordering, missing lock table graceful handling |
| `src/lib/db/locks.ts` | `locks.test.ts` | 2 tests — unique violation → `false` (error code `23505`), `releaseUserLock` filters by `user_id` |

#### Tier 2: Integration Tests (22 tests, need DB)

**Use `describe.skipIf(!HAS_DB)` — gracefully skip when `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are not set.** Mock only AI + Google APIs. All DB operations, scoring, token generation, and service orchestration run for real.

| File | Tests | What's tested |
|------|-------|---------------|
| `src/services/integration.test.ts` | 19 | **Planning (3):** conversation → AI → scored action in real DB with exact priority score assertion, blacklisted CP skipped, weight clamping 0-100. **Morning Brief (6):** real HMAC token round-trip, email HTML content verification, action marked notified in real DB, unsubscribed skip, 10-action cap, afternoon greeting. **Bulk Ingestion (5):** real DB message storage, blocked sender skip, category skip, enrichment tracking, user-not-found early return. **Ingestion→Threading (5):** real CP creation in DB, blocked sender skip, duplicate skip, external thread ID matching, new conversation creation |
| `src/services/agent-pipeline.test.ts` | 5 | Agent pipeline data flow: emails → threading → planning in real DB, calendar + lead tracking aggregation, step 2 fault isolation, step 4-5 skip on empty, WhatsApp message counting |
| `src/services/bulk-ingestion.test.ts` | 6 | Phase 4 enrichment with real DB: phase ordering (report before enrich), report sent even on enrichment failure, classify + update + embedding in real DB, embedding failure still counts as enriched, progress streaming, no-op when no unenriched messages |

#### Tier 3: Smoke Tests (10 tests, opt-in)
**File:** `src/__tests__/smoke.test.ts`

Real HTTP calls against a running instance with **content verification** (not just status codes). Gated behind `SMOKE_TEST=1`. Reads `MILA_USER_API_KEY` and `CRON_SECRET` from env.

```bash
SMOKE_TEST=1 npm test -- src/__tests__/smoke.test.ts
SMOKE_BASE_URL=https://mila.specialagents.pro SMOKE_TEST=1 npm test -- src/__tests__/smoke.test.ts
```

Test user: `podtwo@gmail.com` (`d1a403fd-121b-4dcc-96aa-0efa3af114a8`)

Tests: health check (full status object), auth rejection with wrong/missing keys (4 tests), agent run (all fields + correct types + non-negative values), morning brief (userId + briefType), GDPR export (structure + user data + arrays), WhatsApp status, trigger pixel (image content-type).

#### Tier 4: E2E Tests (12 tests, opt-in, 100% live)
**File:** `src/__tests__/e2e.test.ts`

**Nothing is mocked.** Real AI, real DB, real email, real everything. Gated behind `E2E_TEST=1`. **WARNING: triggers real AI calls and may incur costs. Also sends real emails and modifies real data.**

```bash
E2E_TEST=1 npm test -- src/__tests__/e2e.test.ts
```

Required env vars: `E2E_TEST=1`, `MILA_USER_API_KEY`, `CRON_SECRET`. Optional: `E2E_BASE_URL` (defaults to `http://localhost:3000`).

| Workflow | Tests | What's verified |
|----------|-------|-----------------|
| Agent → Brief cycle | 2 | Full agent pipeline returns valid numeric fields, then morning brief runs on same data |
| GDPR data integrity | 1 | Export returns all data categories with correct structure (user, counterparties, conversations, messages, actions, emails, todos, events) |
| Manual ingest trigger | 1 | POST /api/ingest triggers ingestion successfully |
| System health | 3 | Health check, trigger pixel GIF, WhatsApp status |
| Auth boundaries (live) | 5 | 5 protected routes reject without auth (agent/run, ingest, gdpr/export, gdpr/delete, cron/morning-brief) |

### When to update tests

1. **You changed a function's behavior** → Update the test that pins the old behavior. If the test still passes after your change, the test wasn't covering what you changed — add a test that does.

2. **You changed any default setting value** → Update `defaults.test.ts` with the new value AND the field count.

3. **You added a new API route** → Add auth rejection tests in `route-protection.test.ts`.

4. **You added a new exported function** to an already-tested file → Add tests in the existing `.test.ts` file.

5. **You created a new file with deterministic logic** (pure functions, formulas, matching rules, crypto) → Create a co-located `.test.ts` file.

6. **You changed orchestration flow** (error handling paths, parallel vs serial, lock behavior, retry logic) → Update or add tests in the relevant service test file.

### When NOT to add tests

- **AI prompt text** — changes constantly, not deterministic, not testable by string matching
- **"Did you call the right Supabase method" tests** — these test code structure not behavior. Test the *behavioral outcome* instead.

### Run `npm test` before every commit. Tests must pass alongside `npm run build`.
