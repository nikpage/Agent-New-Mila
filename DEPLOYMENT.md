# Mila Deployment Guide

This guide covers deploying Mila for a new customer with proper security, monitoring, and disaster recovery.

---

## 📋 Pre-Deployment Checklist

### 1. Environment Variables

All environment variables must be configured in your deployment platform (Vercel, Railway, etc.). Use `.env.example` as a reference.

**Critical Security Variables:**
```bash
# Generate unique keys for each customer deployment
MILA_USER_API_KEY=$(node -e "console.log(require('crypto').randomUUID())")
CRON_SECRET=$(openssl rand -hex 32)
SUPERADMIN_KEY=$(openssl rand -hex 32)
```

**Sentry Setup (Error Monitoring):**
1. Create a free account at https://sentry.io
2. Create a new Next.js project
3. Copy the DSN and add to environment variables:
   - `SENTRY_DSN` (server-side)
   - `NEXT_PUBLIC_SENTRY_DSN` (client-side)
4. For source map uploads (optional but recommended):
   - `SENTRY_ORG` (your organization slug)
   - `SENTRY_PROJECT` (your project slug)
   - `SENTRY_AUTH_TOKEN` (from Settings → Auth Tokens)

### 2. Database Setup (Supabase)

**For New Customer (Shared Instance):**
- Existing customers already share the Supabase instance
- No additional setup needed
- Ensure RLS policies are enabled (see `SECURITY.md`)

**For New Supabase Instance:**
1. Create project at https://supabase.com
2. Run database migrations (if available)
3. Copy `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
4. Enable Row Level Security (RLS) on all tables

### 3. Google Cloud Setup

Each customer needs their own Google Cloud project for OAuth:

1. **Create Google Cloud Project**: https://console.cloud.google.com
2. **Enable APIs**:
   - Gmail API
   - Google Calendar API
   - Google Maps API (optional, for location features)
3. **Create OAuth Credentials**:
   - Go to APIs & Services → Credentials
   - Create OAuth 2.0 Client ID (Web Application)
   - Add authorized redirect URI: `https://your-deployment.vercel.app/api/auth/callback`
   - Copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
4. **Get Maps API Key** (optional):
   - Create API Key in Credentials
   - Restrict to Google Maps Geocoding API

### 4. Gemini AI Setup

1. Get API key: https://makersuite.google.com/app/apikey
2. Add to `GEMINI_API_KEY` environment variable

---

## 🚀 Deployment Steps

### Option A: Vercel (Recommended)

1. **Deploy to Vercel:**
   ```bash
   vercel --prod
   ```

2. **Configure Environment Variables:**
   - Go to Vercel Dashboard → Settings → Environment Variables
   - Add all variables from `.env.example`
   - Generate unique security keys (see above)

3. **Set Up Cron Jobs:**
   - Vercel automatically detects `vercel.json` cron configuration
   - Ensure `CRON_SECRET` matches in both Vercel env vars and cron config

4. **Verify Deployment:**
   ```bash
   curl https://your-app.vercel.app/api/health
   ```

### Option B: Docker

```bash
docker build -t mila .
docker run -p 3000:3000 --env-file .env mila
```

---

## 🔐 Security Post-Deployment

### 1. Test Authentication

Test that API endpoints are properly protected:

```bash
# This should fail (401/403):
curl -X POST https://your-app.vercel.app/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"userId": "test"}'

# This should succeed:
curl -X POST https://your-app.vercel.app/api/agent/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_MILA_USER_API_KEY" \
  -d '{"userId": "valid-user-id"}'
```

### 2. Verify Sentry

1. Trigger a test error:
   ```bash
   curl https://your-app.vercel.app/api/nonexistent
   ```
2. Check Sentry dashboard for error report

### 3. Test OAuth Flow

1. Visit `https://your-app.vercel.app`
2. Click "Connect Google Account"
3. Complete OAuth flow
4. Verify user is created in Supabase

---

## 💾 Backup Strategy

### Automated Backups (Recommended)

**For Supabase Pro Plan ($25/month):**
- Daily automated backups included
- Enable in Dashboard → Settings → Backups

**For Free/Hobby Plan:**
Manual weekly exports required (see below).

### Manual Backup Process

**Schedule:** Weekly (every Sunday)

**Script to run:**
```bash
#!/bin/bash
# backup-supabase.sh

DATE=$(date +%Y%m%d)
BACKUP_DIR="./backups/$DATE"

mkdir -p "$BACKUP_DIR"

# Export via Supabase Dashboard:
# 1. Go to Database → Backups
# 2. Click "Create Backup"
# 3. Download .sql file
# 4. Save to $BACKUP_DIR

# Or use pg_dump if you have DB password:
# pg_dump -h db.your-project.supabase.co \
#   -U postgres \
#   -d postgres \
#   -F c \
#   -f "$BACKUP_DIR/mila-backup-$DATE.dump"

echo "Backup created: $BACKUP_DIR"

# Upload to S3/Dropbox/etc (optional):
# aws s3 cp "$BACKUP_DIR" s3://your-bucket/mila-backups/ --recursive
```

**Retention Policy:**
- Keep last 4 weekly backups (1 month)
- Keep 1 monthly backup for 6 months
- Store off-site (S3, Dropbox, Google Drive)

---

## 📊 Monitoring & Maintenance

### Daily Checks

1. **Sentry Dashboard**: Review any errors from last 24h
2. **Vercel Logs**: Check for unusual activity or failed requests
3. **Supabase Dashboard**: Monitor database size and performance

### Weekly Maintenance

1. **Database Backup**: Run manual backup if not using Supabase Pro
2. **Review Logs**: Check for recurring errors or patterns
3. **Update Dependencies**: `npm audit` and address vulnerabilities

### Monthly Reviews

1. **Cost Review**: Check Supabase, Vercel, and Gemini usage
2. **Performance**: Review slow queries in Supabase
3. **Security Audit**: Review access logs and failed auth attempts

---

## 🚨 Incident Response

### Application Errors

1. **Check Sentry**: Identify the error and stack trace
2. **Check Vercel Logs**: See full request context
3. **Check Supabase Logs**: Identify database issues
4. **Rollback if Needed**: `vercel rollback` to previous deployment

### Data Loss

1. **Identify Scope**: What data was lost? When?
2. **Restore from Backup**:
   ```bash
   # Download latest backup
   # Restore to Supabase using Dashboard or psql
   psql -h db.your-project.supabase.co \
     -U postgres \
     -d postgres \
     -f backup-YYYYMMDD.sql
   ```
3. **Verify Restore**: Check that data is complete
4. **Identify Root Cause**: Prevent future incidents

### Security Breach

1. **Rotate All Secrets**: Generate new values for:
   - `MILA_USER_API_KEY`
   - `CRON_SECRET`
   - `NEXTAUTH_SECRET`
   - `SUPABASE_SERVICE_KEY` (if compromised)
2. **Revoke OAuth Tokens**: Use Google Cloud Console
3. **Audit Access**: Check Supabase logs for unauthorized access
4. **Notify Users**: If user data accessed

---

## 📞 Support

**For Deployment Issues:**
- Check Vercel docs: https://vercel.com/docs
- Check Supabase docs: https://supabase.com/docs

**For Application Bugs:**
- Check Sentry for error details
- Review `CLAUDE.md` for code architecture

**For Security Concerns:**
- Review `SECURITY.md`
- Contact security@your-company.com (replace with your contact)

---

## 🔄 Updating Mila

### For Bug Fixes and Minor Updates

```bash
git pull origin main
vercel --prod
```

### For Major Updates

1. **Test Locally**: `npm run build` and `npm run dev`
2. **Deploy to Preview**: `vercel` (without --prod)
3. **Test Preview URL**: Verify everything works
4. **Promote to Production**: `vercel promote <deployment-url>`

---

## 📝 Customer-Specific Configuration

Each customer deployment should have:

1. **Unique Domain**: `customer-name.yourdomain.com`
2. **Unique API Key**: Never reuse `MILA_USER_API_KEY`
3. **Separate Google Project**: Each customer needs their own OAuth credentials
4. **Separate Sentry Project** (optional): For isolated error tracking

**Deployment Naming Convention:**
```
mila-[customer-name]-[environment]
```

Examples:
- `mila-acme-prod`
- `mila-acme-staging`
- `mila-internal-demo`

---

## ✅ Post-Deployment Verification

Run through this checklist after every deployment:

- [ ] Health check passes: `curl https://your-app/api/health`
- [ ] OAuth flow works: Connect Google account
- [ ] Email ingestion works: Trigger `/api/ingest`
- [ ] Agent runs successfully: Check `/api/agent/run`
- [ ] Cron job configured: Verify in Vercel dashboard
- [ ] Sentry receiving errors: Trigger test error
- [ ] Database backup scheduled: Confirm automation or calendar reminder
- [ ] API key protection working: Test unauthorized request (should fail)
- [ ] All environment variables set: Double-check `.env.example`

---

**Last Updated:** 2026-02-13
**For Questions:** See `CLAUDE.md` for code architecture or `SECURITY.md` for security details.
