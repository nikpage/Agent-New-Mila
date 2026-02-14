# Mila Security Documentation

This document outlines the security architecture, known risks, and mitigation strategies for Mila.

**Last Updated:** 2026-02-13
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
**File:** `src/lib/auth/tokens.ts:132-143`

- All cron endpoints require `CRON_SECRET` in Authorization header
- Rejects requests if secret not configured (secure by default)
- Protects automated email processing from unauthorized triggers

**Protected endpoints:**
- `/api/cron/morning-brief` (daily 8am brief)

#### 2. Action Token Authentication
**File:** `src/lib/auth/tokens.ts:7-60`

- Email action links contain HMAC-signed tokens
- Token proves: "User X owns action Y"
- 7-day expiry window
- One-time use (action marked completed after execution)

**Protected flows:**
- User clicks email → `/api/action/[id]/execute?token=xyz`
- Token validates `actionId` + `userId` + `timestamp`

#### 3. API Key Protection (NEW)
**File:** `src/lib/auth/api.ts`

- Manual triggers require `MILA_USER_API_KEY` in `x-api-key` header
- Each deployment has unique key
- Protects `/api/agent/run` and `/api/ingest` from unauthorized access

**Use case:** Admin manually triggers processing for specific user

#### 4. Row Level Security (RLS)
**Location:** Supabase Database

- All tables have `user_id` column with RLS policies
- API routes use service key (bypasses RLS) → MUST manually filter by `user_id`
- Prevents cross-customer data access

**Critical for shared database architecture**

#### 5. OAuth Token Storage
**Current state:** Plaintext in `users.google_tokens` JSONB column

**Risk:** If `SUPABASE_SERVICE_KEY` leaks → all Gmail access compromised

**Accepted for now:** Strong service key + Vercel env encryption + limited customer count (<20)

#### 6. Health Endpoint Hardening (NEW)
**File:** `src/app/api/health/route.ts`

- Returns generic "Configuration incomplete" instead of leaking env var names
- Prevents reconnaissance attacks

#### 7. Error Monitoring (NEW)
**Sentry:** Client + server + edge runtime tracking

---

## ⚠️ KNOWN RISKS & MITIGATIONS

### 🔴 HIGH RISK: OAuth Tokens in Plaintext

**Current State:**
- Gmail/Calendar access tokens stored unencrypted
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

### Before 10th Customer (CRITICAL)
- [ ] **Encrypt OAuth tokens** (Supabase Vault or app-level) - 3 hours
  - **Why:** Plaintext tokens = catastrophic if leaked
  - **How:** Supabase Vault or AES encryption with `NEXTAUTH_SECRET`

### Before 20th Customer
- [ ] **Per-user audit logs** - 2 hours
  - **Why:** Forensics for security incidents, compliance (GDPR)
  - **What:** Log `user_id`, `action`, `timestamp`, `ip_address`

- [ ] **Separate Supabase for high-value customers** - 4 hours
  - **Why:** Isolate blast radius, better performance
  - **When:** Enterprise customers with >100 users

### If Adding WhatsApp Bot
- [ ] **Rate limiting per phone number** (Upstash Redis) - 2 hours
- [ ] **WhatsApp webhook signature verification** - 1 hour
- [ ] **Message encryption** for sensitive data - 2 hours

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
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment guide
- [CLAUDE.md](./CLAUDE.md) - Code architecture

---

**Document Version:** 2.0 (Architecture-corrected)
**Last Review:** 2026-02-13
**Next Review:** 2026-05-13 (quarterly)
