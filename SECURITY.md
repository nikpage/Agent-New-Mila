# Mila Security Documentation

This document outlines the security architecture, known risks, and mitigation strategies for Mila.

**Last Updated:** 2026-02-18
**Architecture:** Event-driven email automation agent (NOT interactive SaaS)

---

## 🏗️ System Architecture

### What Mila Actually Is

**Mila is an automated email assistant, not a web application:**
- Cron job processes user emails daily → generates action proposals
- Actions are sent to users via email with magic links
- Users click links to approve/execute actions
- Minimal web UI only for OAuth setup

**User Interaction Model:**
```
Gmail → Cron ingests → Agent processes → Creates actions → Emails user
User clicks email link → Verifies token → Executes action → Done
```

**NOT a traditional SaaS:**
- ❌ No user dashboard with buttons to click
- ❌ No user-initiated API calls
- ❌ No session-based login
- ❌ No interactive web UI (beyond OAuth setup)

### Multi-Customer Deployment Model

**Shared Database:** All customers use ONE Supabase instance
- RLS (Row Level Security) policies enforce data isolation
- Each customer has unique `user_id` UUID
- Cron jobs process all users sequentially

---

## 🔐 Current Security Controls

### ✅ IMPLEMENTED

#### 1. Cron Job Protection
**File:** `src/lib/auth/tokens.ts`

- All cron endpoints require `CRON_SECRET` in Authorization header
- Rejects requests if secret not configured (secure by default)
- **Timing-safe comparison** (`crypto.timingSafeEqual`) prevents timing attacks
- Protects automated email processing from unauthorized triggers

**Protected endpoints:**
- `/api/cron/morning-brief` (daily 8am brief)

#### 2. Action Token Authentication
**File:** `src/lib/auth/tokens.ts`

- Email action links contain HMAC-signed tokens
- Token proves: "User X owns action Y"
- 7-day expiry window
- One-time use (action marked completed after execution)
- **Timing-safe comparison** on all signature verifications

**Protected flows:**
- User clicks email → `/api/action/[id]/execute?token=xyz`
- Token validates `actionId` + `userId` + `timestamp`

#### 3. API Key Protection
**File:** `src/lib/auth/api.ts`

- Manual triggers require `MILA_USER_API_KEY` in `x-api-key` header
- Each deployment has unique key
- **Timing-safe comparison** (`crypto.timingSafeEqual`) prevents timing attacks
- Protects `/api/agent/run` and `/api/ingest` from unauthorized access

**Use case:** Admin manually triggers processing for specific user

#### 4. Trigger Pixel Authentication
**File:** `src/lib/auth/tokens.ts` + `src/app/api/trigger/ingest/route.ts`

- Tracking pixel URL embedded in brief emails is **HMAC-signed**: `?uid=<userId>&sig=<hmac>`
- Unsigned or tampered URLs silently return the 1x1 GIF (no info leak) but do NOT trigger agent runs
- `generateTriggerToken()` signs with `NEXTAUTH_SECRET`; `validateTriggerToken()` verifies with timing-safe comparison
- Tokens are non-expiring (pixel URLs are baked into every email ever sent; replay limited to triggering a non-destructive agent run)

**Previously:** Any UUID in `?uid=` would trigger a full agent pipeline — no auth at all.

#### 5. Per-User Agent Concurrency Lock
**File:** `src/services/agent.ts`

- In-memory `Map<userId, true>` prevents two simultaneous pipeline runs for the same user
- Second concurrent call returns immediately with `success: true` + `errors: ['Skipped — concurrent run already in progress']`
- Lock releases in `finally` block (crash-safe)
- Prevents duplicate messages, CPs, and action proposals from race conditions (e.g. cron + email-open firing simultaneously)

**Limitation:** In-memory lock per Vercel instance — two cold-start instances could still race, but this eliminates the most common case.

#### 6. Row Level Security (RLS)
**Location:** Supabase Database

- All tables have `user_id` column with RLS policies
- API routes use service key (bypasses RLS) → MUST manually filter by `user_id`
- Prevents cross-customer data access

**Critical for shared database architecture**

#### 7. OAuth Token Storage
**Current state:** Plaintext in `users.google_oauth_tokens` JSONB column

**Risk:** If `SUPABASE_SERVICE_KEY` leaks → all Gmail access compromised

**Accepted for now:** Strong service key + Vercel env encryption + limited customer count (<20)

#### 8. Health Endpoint (**NOT YET HARDENED**)
**File:** `src/app/api/health/route.ts`

- **Current state:** Lists which specific env vars are present/absent by name and includes raw DB error messages
- **TODO:** Return generic "Configuration incomplete" instead of leaking env var names

#### 9. Error Monitoring
**Sentry:** Client + server + edge runtime tracking. `sendDefaultPii: false` (no request bodies/headers sent). `tracesSampleRate: 0.1` (10% sampling).

#### 10. Data Integrity: Atomic Counterparty Creation
**File:** `src/lib/db/counterparties.ts`

- `findOrCreateCP()` uses **upsert-first** pattern with `ON CONFLICT (user_id, primary_identifier) DO NOTHING`
- Eliminates race condition where two concurrent messages from the same unknown sender both insert a duplicate CP
- Falls back to SELECT only if upsert returns no rows (conflict path)

#### 11. OAuth Token Caching
**File:** `src/lib/google/auth.ts`

- In-memory cache with 4-minute TTL on `getAuthenticatedClient()`
- Eliminates tens of thousands of redundant DB reads per cron cycle at scale
- Cache invalidates on token refresh and on refresh failure
- TTL (4 min) is shorter than refresh window (5 min before expiry) to ensure stale tokens are never served

#### 12. Timing-Safe Comparisons (All Auth Paths)
**Files:** `src/lib/auth/tokens.ts`, `src/lib/auth/api.ts`

All secret comparisons use `crypto.timingSafeEqual`:
- API key verification (`verifyApiKey`)
- Cron token validation (`validateCronToken`)
- Action token validation (`validateActionToken`)
- OAuth state validation (`validateOAuthState`)
- Trigger pixel validation (`validateTriggerToken`)

---

## ⚠️ KNOWN RISKS & MITIGATIONS

### 🟡 MEDIUM RISK: OAuth Token Encryption Migration In Progress

**Current State:**
- Tokens now encrypted with AES-256-GCM and written to `users.encrypted_google_tokens`
- Plaintext `users.google_oauth_tokens` still written (dual-write) for safe rollback
- `getAuthenticatedClient()` reads encrypted first, falls back to plaintext
- Refresh tokens valid until revoked (persistent access)

**Impact if compromised:** CATASTROPHIC
- Read all customer emails
- Send emails as customers
- Access calendars
- Persist access indefinitely

**Current Mitigation:**
1. Strong 64+ char `SUPABASE_SERVICE_KEY`
2. Vercel environment variables (encrypted at rest, SOC 2)
3. RLS policies (but service key bypasses)
4. Limited blast radius (<20 customers)

**REQUIRED: Encrypt before 10 customers**

**Options:**
1. **Supabase Vault** (recommended) - Built-in encryption, transparent to code
2. **Application-level encryption** - Encrypt with `NEXTAUTH_SECRET` before storing

---

### 🟡 MEDIUM RISK: Shared Supabase Instance

**Current State:**
- All customers share ONE database
- RLS + API filtering enforces isolation

**Risks:**
1. **Code bug** → API route forgets `user_id` filter → cross-customer leak
2. **Performance** → One customer's load affects others
3. **Blast radius** → Supabase outage = all customers down

**Mitigation:**
- Code review: Verify all queries filter by `user_id`
- Monitoring: Sentry alerts on DB errors
- Testing: Integration tests for data isolation

**Future:** Separate Supabase for enterprise customers (>100 users)

---

### 🟡 MEDIUM RISK: Cron Token in Environment

**Current State:**
- `CRON_SECRET` stored in Vercel env vars
- Vercel Cron automatically includes correct token

**Risk:** If Vercel account compromised → attacker can trigger cron jobs

**Impact:** Medium (can process emails, but can't read results without DB access)

**Mitigation:**
- Strong Vercel account password + 2FA
- Limit Vercel team members
- Monitor Sentry for unexpected cron runs

---

### 🟢 LOW RISK: Action Token Interception

**Current State:**
- 7-day expiry on email action links
- Tokens are HMAC-signed (can't forge)

**Risk:** Email compromise within 7 days = attacker can execute action

**Impact:** Low-Medium (attacker can reply/schedule as user, but only once per action)

**Mitigation:**
- 7-day expiry limits window
- One-time use (action completes after execution)
- Email security is user's responsibility

**Enhancement (optional):** Reduce expiry to 24 hours

---

### 🟢 LOW RISK: API Key for Manual Triggers

**Current State:**
- `/api/agent/run` accepts `userId` in request body with API key
- Trusts caller to provide correct `userId`

**Risk:** Malicious admin/script could process wrong user's emails

**Impact:** Low (assumes single trusted admin per deployment)

**Mitigation:**
- Single-customer deployments (1-5 trusted users)
- Map API keys to specific `userId` if needed

---

## 🛡️ Security Best Practices

### For Developers

1. **Always filter by user_id**
   ```typescript
   // ✅ GOOD
   const actions = await supabase
     .from('action_proposals')
     .select('*')
     .eq('user_id', userId)

   // ❌ BAD (exposes all users' data)
   const actions = await supabase
     .from('action_proposals')
     .select('*')
   ```

2. **Never log secrets**
   ```typescript
   // ❌ BAD
   console.log('OAuth tokens:', user.google_oauth_tokens)

   // ✅ GOOD
   console.log('User authenticated:', user.email)
   ```

3. **Validate user ownership**
   ```typescript
   const action = await getActionById(actionId)
   if (action.user_id !== userId) {
     return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
   }
   ```

### For Operators

1. **Rotate secrets quarterly**
   - `MILA_USER_API_KEY` every 3 months
   - `CRON_SECRET` every 6 months
   - Update Vercel env vars

2. **Monitor Sentry daily**
   - Review errors from last 24 hours
   - Set up Slack alerts for critical errors

3. **Review Vercel logs weekly**
   - Check for unusual patterns
   - Watch for repeated 401/403 errors

4. **Backup database weekly**
   - Manual export if Free tier
   - Automated if Pro tier ($25/month)

---

## 🚨 Incident Response

### OAuth Token Leak

**If SUPABASE_SERVICE_KEY compromised:**

1. **Immediate (within 15 minutes):**
   - Rotate `SUPABASE_SERVICE_KEY` in Supabase dashboard
   - Update Vercel environment variables
   - Redeploy application

2. **Within 1 hour:**
   - Review Supabase logs for unauthorized access
   - Revoke all user OAuth tokens via Google Admin Console
   - Force users to re-authenticate

3. **Within 24 hours:**
   - Notify affected customers
   - Document incident
   - Implement OAuth token encryption

### Unauthorized Cron Execution

**If CRON_SECRET leaked:**

1. **Immediate:**
   - Generate new `CRON_SECRET`
   - Update Vercel environment variables
   - Update Vercel cron configuration

2. **Within 1 hour:**
   - Review logs for unauthorized cron runs
   - Check for unexpected actions created
   - Audit Sentry for anomalies

### Data Loss

**If database corrupted/deleted:**

1. **Immediate:**
   - Identify scope (which users, which data, time range)
   - Download latest backup

2. **Within 2 hours:**
   - Restore from backup
   - Verify data integrity
   - Test critical flows (OAuth, cron, actions)

3. **Post-mortem:**
   - Document root cause
   - Implement prevention (more frequent backups, checksums)

---

## 📋 Security Checklist for New Deployments

- [ ] Generate unique `MILA_USER_API_KEY` (never reuse)
- [ ] Generate unique `CRON_SECRET` (never reuse)
- [ ] Set strong `NEXTAUTH_SECRET` (32+ bytes)
- [ ] Configure Sentry DSN (separate project per customer)
- [ ] Create separate Google Cloud project (isolate OAuth)
- [ ] Enable Supabase RLS on all tables
- [ ] Test unauthorized API access (should fail with 401)
- [ ] Test OAuth flow end-to-end
- [ ] Set up backup automation or calendar reminder
- [ ] Verify cron job runs successfully

---

## 🔄 Security Roadmap

### ✅ COMPLETED (2026-02-18)
- [x] **HMAC-signed trigger pixel URL** — prevents unauthorized agent runs via tracking pixel
- [x] **Per-user agent concurrency lock** — prevents duplicate pipeline runs from race conditions
- [x] **Timing-safe comparisons on all auth paths** — API key, cron, action tokens, OAuth state, trigger tokens
- [x] **Atomic counterparty creation** — upsert-first eliminates findOrCreateCP race condition
- [x] **OAuth token caching** — 4-min TTL eliminates redundant DB reads at scale

### ✅ COMPLETED (2026-02-19)
- [x] **Sentry PII leak fixed** — `sendDefaultPii: false` on server + edge; `tracesSampleRate` reduced from 1.0 to 0.1
- [x] **Action execute idempotency** — returns 409 if action already completed (prevents double-send)
- [x] **Pipeline error isolation** — each step wrapped in try/catch; Gmail failure no longer kills threading/planning/lead-tracking
- [x] **Non-actionable email loop** — classified emails now stored as minimal records to prevent re-classification every run
- [x] **Timezone parsing hardened** — replaced fragile `toLocaleString` date parsing with `Intl.DateTimeFormat.formatToParts`
- [x] **OAuth token encryption** — AES-256-GCM via `src/lib/crypto.ts`, key derived from `NEXTAUTH_SECRET` via HKDF. Dual-write to both columns; reads encrypted first, falls back to plaintext.
- [x] **Health endpoint hardened** — returns generic status messages, no env var names or raw DB errors
- [x] **Sentry test endpoint removed** — `/api/sentry-test` deleted (was unauthenticated, could exhaust Sentry quota)
- [x] **WhatsApp status endpoint auth** — `/api/whatsapp/status` now requires API key
- [x] **Calendar invitation CP filter** — invitations attached to correct conversation (filtered by CP, not random `limit(1)`)
- [x] **daysIgnored fix** — measures last inbound CP message, not `conversation.last_updated`
- [x] **Settings merge** — `updateUserSettings` now merges with existing settings instead of overwriting
- [x] **Calendar event dedup** — uses stable `google_event_id` instead of fragile `(start, end, title)` match

### Before 20th Customer — GDPR Compliance
- [ ] **User data deletion endpoint** (Right to be Forgotten, GDPR Art. 17) - 4 hours
  - **Why:** GDPR requires ability to delete all personal data on request
  - **What:** Cascade delete: users → cps → conversations → messages → actions → events → embeddings → emails → todos
  - **How:** `/api/superadmin/users/[id]/delete` with confirmation, or self-service via authenticated request
  - **Note:** Must also revoke Google OAuth tokens and purge any cached data

- [ ] **User data export endpoint** (Right to Portability, GDPR Art. 20) - 3 hours
  - **Why:** GDPR requires users can download their data in machine-readable format
  - **What:** Export all user data as JSON: profile, conversations, messages, actions, events
  - **How:** `/api/superadmin/users/[id]/export` returns ZIP with structured JSON

- [ ] **Per-user audit logs** - 2 hours
  - **Why:** Forensics for security incidents, GDPR accountability (Art. 5)
  - **What:** Log `user_id`, `action`, `timestamp`, `ip_address`

- [ ] **Data retention policy** - 1 hour
  - **Why:** GDPR storage limitation (Art. 5) — don't keep data longer than needed
  - **What:** Auto-purge completed actions older than 90 days, processed messages older than 180 days

- [ ] **Separate Supabase for high-value customers** - 4 hours
  - **Why:** Isolate blast radius, better performance
  - **When:** Enterprise customers with >100 users

### Before 500 Users — Scale Hardening
- [ ] **Database-level concurrency lock** (replace in-memory) - 2 hours
  - **Why:** In-memory lock only works per Vercel instance; Postgres advisory locks work globally
  - **How:** `pg_advisory_xact_lock(hashtext(userId))` or Supabase-side lock table

- [ ] **Calendar incremental sync** (sync tokens) - 3 hours
  - **Why:** Current full re-fetch of 14 days of events per user per run wastes Google API quota
  - **How:** Store `nextSyncToken` from Google Calendar API, pass on subsequent calls

- [ ] **Job queue for fan-out** - 4 hours
  - **Why:** Sequential user processing in cron doesn't scale past ~100 users in Vercel's 60s timeout
  - **How:** Inngest, Trigger.dev, or QStash for per-user agent runs

### WhatsApp Daemon (Baileys Multi-Session)
The daemon (`scripts/whatsapp-daemon.ts`) uses `@whiskeysockets/baileys` and manages multiple user sessions on a single process. Security considerations:
- [ ] **Rate limiting per phone number** (Upstash Redis) - 2 hours
- [ ] **Daemon API authentication** — daemon HTTP API (port 3001) is localhost-only but has no auth; add shared secret header if exposing beyond localhost - 1 hour
- [ ] **Auth state file permissions** — `./baileys_auth/<userId>/` dirs contain session keys; ensure restricted file permissions (0700) - 30 minutes
- [ ] **Session isolation** — each user's Baileys socket runs in the same process; a crash in one session's event handler could affect others. Consider per-session error boundaries - 2 hours
- [ ] **Message encryption** for sensitive data in transit/storage - 2 hours

---

## 📞 Security Contacts

**For Security Issues:**
- **Critical:** Immediately notify team lead
- **High:** Create private GitHub issue
- **Medium/Low:** Regular issue tracker

---

## 📚 References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Supabase RLS Best Practices](https://supabase.com/docs/guides/auth/row-level-security)
- [Vercel Security](https://vercel.com/docs/security)
- [CLAUDE.md](./CLAUDE.md) - Code architecture

---

**Document Version:** 3.0 (Security hardening + GDPR roadmap)
**Last Review:** 2026-02-18
**Next Review:** 2026-05-18 (quarterly)
