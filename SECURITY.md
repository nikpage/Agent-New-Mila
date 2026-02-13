# Mila Security Documentation

This document outlines the security architecture, known risks, and mitigation strategies for Mila.

**Last Updated:** 2026-02-13
**Status:** MVP Security Baseline Implemented

---

## 🏗️ Security Architecture

### Authentication Model

**Primary Authentication:** Email Ownership via Google OAuth
- Users authenticate by connecting their Google account
- Ownership of the Gmail/Calendar proves identity
- OAuth tokens stored in Supabase (see risks below)

### Multi-Customer Deployment Model

**Shared Database:** All customers use ONE Supabase instance
- RLS (Row Level Security) policies enforce data isolation
- Each customer has unique `user_id` UUID
- API key per deployment prevents cross-customer access

**Deployment Architecture:**
```
Customer A → Vercel Deployment A → API Key A → Shared Supabase
Customer B → Vercel Deployment B → API Key B → Shared Supabase
Customer C → Vercel Deployment C → API Key C → Shared Supabase
```

---

## 🔐 Current Security Controls

### ✅ IMPLEMENTED (MVP Baseline)

#### 1. API Key Authentication
**File:** `src/lib/auth/api.ts`

- Each customer deployment has unique `CUSTOMER_API_KEY`
- All API endpoints protected except:
  - `/api/auth/*` (OAuth flow, public by necessity)
  - `/api/health` (monitoring, no sensitive data)
  - `/api/cron/*` (protected by `CRON_SECRET`)
  - `/api/action/[id]/*` (protected by action tokens)

**Limitations:**
- Not session-based (all users in deployment share same key)
- Does not verify email ownership per request
- If deployment key leaks → entire deployment compromised

**Mitigation:**
- Generate unique key per deployment
- Rotate keys if compromise suspected
- Monitor Sentry for repeated auth failures

#### 2. Row Level Security (RLS)
**Location:** Supabase Database

- All tables have `user_id` column
- RLS policies ensure users only access their own data
- Service key bypasses RLS (used by API routes)

**Critical Dependency:**
- API routes MUST validate user ownership before querying with service key
- If API route trusts `userId` from request without validation → RLS bypassed

**Verification Needed:**
Review each API route in `src/app/api/` to ensure:
1. User authenticated (API key or token)
2. User owns the resource being accessed

#### 3. Token-Based Action Authorization
**File:** `src/lib/auth/tokens.ts`

- Action links include HMAC-signed tokens
- Tokens expire after 7 days
- Validates `actionId` + `userId` + `timestamp`

**Good:** Prevents unauthorized action execution from email links
**Limitation:** Email interception within 7 days = compromise

#### 4. Cron Job Protection
**File:** `src/lib/auth/tokens.ts:132`

- Cron endpoints require `CRON_SECRET` header
- Rejects requests if secret not configured (secure by default)
- Dev mode now ALSO requires secret (fixed vulnerability)

#### 5. Environment Configuration Validation
**File:** `src/config/env.ts`

- Validates all required env vars at startup
- Application fails fast if misconfigured
- Prevents partial deployments

#### 6. Health Endpoint Hardening
**File:** `src/app/api/health/route.ts`

- No longer leaks missing environment variable names
- Returns generic "Configuration incomplete" error

#### 7. Error Monitoring (Sentry)
**Files:** `sentry.*.config.ts`

- Server-side error tracking
- Client-side error tracking with session replay
- Alerts on new errors

---

## ⚠️ KNOWN RISKS & MITIGATIONS

### 🔴 HIGH RISK: OAuth Tokens Stored in Plaintext

**Current State:**
- Google OAuth tokens (Gmail, Calendar access) stored in `users.google_tokens` JSONB column
- No encryption at rest
- If Supabase service key leaks → attacker gets ALL customers' Gmail access

**Impact:** CATASTROPHIC
- Attacker can read all emails
- Attacker can send emails as users
- Attacker can access calendars
- Attacker can persist access (refresh tokens valid until revoked)

**Current Mitigation (Pragmatic for MVP):**
1. Strong `SUPABASE_SERVICE_KEY` (64+ char random)
2. Service key stored in Vercel environment variables (encrypted at rest)
3. Vercel has SOC 2 compliance
4. RLS policies limit exposure (but service key bypasses)
5. Limited customer count (<20) reduces blast radius

**RECOMMENDED: Migrate to Supabase Vault**
- Supabase Vault encrypts secrets at rest
- Transparent to application code
- Requires Supabase Pro plan ($25/month)
- **Action:** Implement when customer count reaches 10

**Alternative: Application-Level Encryption**
```typescript
// Pseudo-code for future implementation
import { encrypt, decrypt } from '@/lib/encryption'

// On token save:
const encryptedTokens = encrypt(JSON.stringify(tokens), NEXTAUTH_SECRET)
await updateUser(userId, { encrypted_google_tokens: encryptedTokens })

// On token read:
const tokens = JSON.parse(decrypt(user.encrypted_google_tokens, NEXTAUTH_SECRET))
```

**Timeline:**
- **MVP (now):** Accept risk, document, monitor
- **10 customers:** Implement Supabase Vault or app-level encryption
- **20+ customers:** Consider separate Supabase per customer

---

### 🟡 MEDIUM RISK: Shared Database Instance

**Current State:**
- All customers share ONE Supabase instance
- RLS policies + application logic enforces isolation

**Risks:**
1. **RLS Bypass:** Bug in API route could expose cross-customer data
2. **Performance:** One customer's load affects others
3. **Blast Radius:** Supabase outage = all customers down

**Mitigation:**
1. **Code Review:** Ensure all DB queries filter by `user_id`
2. **Testing:** Add integration tests for data isolation
3. **Monitoring:** Sentry alerts on unusual DB access patterns
4. **Rate Limiting:** Add per-customer rate limits (TODO)

**Future:**
- Separate Supabase per enterprise customer (>100 users)
- Consider RDS Multi-Tenant with better isolation

---

### 🟡 MEDIUM RISK: No Session-Based Auth

**Current State:**
- API key shared across all users in deployment
- No per-request email ownership verification

**Risks:**
1. User A can pass User B's `userId` in API request
2. API key leak = entire deployment compromised
3. No audit trail per user

**Current Mitigation:**
- Custom deployment per customer (1-5 users per deployment)
- Trusted users (employees of same company)

**RECOMMENDED: Implement NextAuth.js Session Auth**

Timeline:
- **MVP:** Accept risk (custom deployments = trusted users)
- **Multi-Tenant SaaS:** MUST implement before launch

Example implementation:
```typescript
// Future: src/lib/auth/session.ts
import { getServerSession } from 'next-auth'

export async function requireAuth(req: NextRequest) {
  const session = await getServerSession()
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return session.user
}

// Usage in API routes:
const user = await requireAuth(request)
const userId = user.id // Verified from session, not request body
```

---

### 🟡 MEDIUM RISK: No Rate Limiting

**Current State:**
- No rate limiting on API endpoints
- Attacker with valid API key can exhaust:
  - Gemini API quota
  - Gmail API quota
  - Supabase resources

**Mitigation:**
- Gemini has built-in rate limits (10 req/min)
- Gmail has quotas per user (10k req/day)
- Vercel has DDoS protection

**RECOMMENDED: Add Application-Level Rate Limiting**

Use Upstash Redis + Vercel Edge Config:
```typescript
// Future: src/lib/rate-limit.ts
import { Ratelimit } from '@upstash/ratelimit'

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '1 m'), // 10 requests per minute
})

export async function checkRateLimit(identifier: string) {
  const { success } = await ratelimit.limit(identifier)
  return success
}
```

**Timeline:** Implement before 5th customer

---

### 🟢 LOW RISK: Action Token Interception

**Current State:**
- Action links emailed to users contain 7-day tokens
- Email interception = attacker can execute action

**Likelihood:** Low (requires email compromise + 7-day window)
**Impact:** Medium (attacker can reply/schedule on behalf of user)

**Mitigation:**
- 7-day expiry limits window
- Tokens are HMAC-signed (can't be forged)
- One-time use (action marked completed after execution)

**Enhancement (Optional):**
- Reduce expiry to 24 hours
- Add IP-based anomaly detection

---

### 🟢 LOW RISK: No Database Backups

**Current State (Fixed):**
- `DEPLOYMENT.md` documents backup process
- Manual weekly backups required for Free/Hobby plan
- Automated backups available on Pro plan ($25/month)

**Impact if No Backups:** Data loss = unrecoverable

**Mitigation:**
- Set calendar reminder for weekly exports
- Store backups off-site (S3, Dropbox)
- Test restore process quarterly

---

## 🛡️ Security Best Practices

### For Developers

1. **Never Log Secrets**
   ```typescript
   // ❌ BAD
   console.log('Token:', user.google_tokens)

   // ✅ GOOD
   console.log('User authenticated:', user.email)
   ```

2. **Always Filter by user_id**
   ```typescript
   // ❌ BAD
   const actions = await supabase.from('action_proposals').select('*')

   // ✅ GOOD
   const actions = await supabase
     .from('action_proposals')
     .select('*')
     .eq('user_id', userId)
   ```

3. **Validate User Ownership**
   ```typescript
   // ❌ BAD
   const { actionId, userId } = await request.json()
   const action = await getActionById(actionId)

   // ✅ GOOD
   const { actionId, userId } = await request.json()
   const action = await getActionById(actionId)
   if (action.user_id !== userId) {
     return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
   }
   ```

4. **Use Environment Variables**
   ```typescript
   // ❌ BAD
   const apiKey = 'sk-hardcoded-key-123'

   // ✅ GOOD
   const apiKey = process.env.GEMINI_API_KEY
   if (!apiKey) throw new Error('GEMINI_API_KEY not configured')
   ```

### For Operators

1. **Rotate Secrets Quarterly**
   - Generate new `CUSTOMER_API_KEY` every 3 months
   - Update Vercel environment variables
   - No downtime (keys can overlap during rotation)

2. **Monitor Sentry Daily**
   - Review errors from last 24 hours
   - Set up Slack alerts for critical errors

3. **Review Access Logs Weekly**
   - Check Vercel logs for unusual patterns
   - Watch for repeated 401/403 errors (attack attempts)

4. **Test Backups Quarterly**
   - Download latest backup
   - Restore to test Supabase instance
   - Verify data integrity

---

## 🚨 Incident Response Playbook

### Suspected API Key Leak

1. **Immediate:**
   - Generate new `CUSTOMER_API_KEY`
   - Update Vercel environment variables
   - Redeploy (triggers immediate key rotation)

2. **Within 1 Hour:**
   - Review Vercel logs for unauthorized requests
   - Check Sentry for unusual errors
   - Audit Supabase for unexpected data changes

3. **Within 24 Hours:**
   - Identify leak source (git history, logs, screenshot)
   - Document incident
   - Update security procedures

### Suspected Database Compromise

1. **Immediate:**
   - Rotate `SUPABASE_SERVICE_KEY` (in Supabase dashboard)
   - Update Vercel environment variables
   - Revoke all user OAuth tokens (force re-auth)

2. **Within 1 Hour:**
   - Review Supabase logs for unauthorized access
   - Identify compromised data
   - Notify affected users if PII accessed

3. **Within 24 Hours:**
   - Restore from latest backup if data modified
   - Implement additional monitoring
   - Consider migrating to separate Supabase instance

### Data Loss Event

1. **Immediate:**
   - Identify scope (which users, which data, time range)
   - Download latest backup

2. **Within 2 Hours:**
   - Restore from backup (see `DEPLOYMENT.md`)
   - Verify data integrity
   - Notify affected users

3. **Post-Mortem:**
   - Identify root cause
   - Implement prevention (more frequent backups, checksums)
   - Update runbooks

---

## 📋 Security Checklist for New Deployments

Before deploying for a new customer:

- [ ] Generate unique `CUSTOMER_API_KEY` (never reuse)
- [ ] Generate unique `CRON_SECRET` (never reuse)
- [ ] Set strong `NEXTAUTH_SECRET` (32+ bytes)
- [ ] Configure Sentry project (isolate customer errors)
- [ ] Create separate Google Cloud project (isolate OAuth)
- [ ] Enable Supabase RLS on all tables
- [ ] Test unauthorized API access (should fail)
- [ ] Test OAuth flow end-to-end
- [ ] Set up backup automation or calendar reminder
- [ ] Document deployment in internal wiki

---

## 🔄 Roadmap: Security Enhancements

### Before 5th Customer
- [ ] Add rate limiting (Upstash Redis)
- [ ] Add request logging middleware
- [ ] Implement automated backup verification

### Before 10th Customer
- [ ] **CRITICAL:** Encrypt OAuth tokens (Vault or app-level)
- [ ] Implement session-based auth (NextAuth.js)
- [ ] Add per-user audit logs
- [ ] Set up security alerting (Slack/PagerDuty)

### Before 20th Customer
- [ ] Consider separate Supabase per customer
- [ ] Implement IP allowlisting for admin endpoints
- [ ] Add anomaly detection (unusual activity patterns)
- [ ] Security audit by third party

### Production SaaS Launch
- [ ] **REQUIRED:** Session-based authentication
- [ ] **REQUIRED:** OAuth token encryption
- [ ] SOC 2 compliance
- [ ] Penetration testing
- [ ] Bug bounty program

---

## 📞 Security Contacts

**For Security Issues:**
- **Critical (data breach, active attack):** Immediately notify team lead
- **High (vulnerability discovered):** Create private GitHub issue, tag @security
- **Medium/Low:** Create issue in regular tracker

**External Reporting:**
- Email: security@your-company.com (replace with actual contact)
- PGP Key: [Link to public key if applicable]

---

## 📚 References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Supabase RLS Best Practices](https://supabase.com/docs/guides/auth/row-level-security)
- [Vercel Security](https://vercel.com/docs/concepts/secure)
- [Google OAuth Best Practices](https://developers.google.com/identity/protocols/oauth2/web-server)

---

**Document Version:** 1.0
**Last Review:** 2026-02-13
**Next Review:** 2026-05-13 (quarterly)
