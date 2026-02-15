# Client Onboarding Guide

Step-by-step CLI guide for deploying Mila for a new client.

## Prerequisites

- Node.js 18+ and npm
- Vercel CLI (`npm i -g vercel`)
- Supabase CLI (`npm i -g supabase`)
- GitHub CLI (`gh`) — for repo setup
- Google Cloud Console access
- Client's Google Workspace email

## 1. Clone and Fork

```bash
# Clone the base repo
git clone git@github.com:yourorg/mila.git mila-clientname
cd mila-clientname

# Remove origin, set up new private repo
git remote remove origin
gh repo create yourorg/mila-clientname --private --source=. --push
```

## 2. Create Supabase Project

```bash
# Login to Supabase
supabase login

# Create a new project (interactive — pick region closest to client)
supabase projects create mila-clientname --org-id YOUR_ORG_ID

# Note the project ref from output
export SUPABASE_PROJECT_REF=<project-ref>
export SUPABASE_URL=https://${SUPABASE_PROJECT_REF}.supabase.co

# Get the service key
supabase projects api-keys --project-ref $SUPABASE_PROJECT_REF
# Copy the service_role key — this is SUPABASE_SERVICE_KEY
```

### Apply Database Schema

```bash
# Link to the project
supabase link --project-ref $SUPABASE_PROJECT_REF

# Run migrations (if using Supabase migrations)
supabase db push

# Or apply schema manually via SQL editor in Supabase dashboard
# Tables needed: users, cps, channels, cp_states, conversation_threads,
# messages, thread_participants, message_embeddings, action_proposals,
# emails, todos, events, agent_errors
```

### Enable pgvector

```sql
-- Run in Supabase SQL editor
CREATE EXTENSION IF NOT EXISTS vector;
```

## 3. Google Cloud Setup

### Create OAuth Credentials

```bash
# Open Google Cloud Console
open https://console.cloud.google.com

# 1. Create new project or select existing
# 2. Enable APIs:
#    - Gmail API
#    - Google Calendar API
#    - Distance Matrix API (for travel time)
# 3. Create OAuth 2.0 credentials:
#    - Application type: Web application
#    - Authorized redirect URI: https://mila-clientname.vercel.app/api/auth/callback
#    - (Also add http://localhost:3000/api/auth/callback for dev)
# 4. Copy Client ID and Client Secret
```

### Get Gemini API Key

```bash
open https://aistudio.google.com/apikey
# Create API key, copy it
```

### Get Maps API Key

```bash
# In Google Cloud Console:
# 1. Go to APIs & Services > Credentials
# 2. Create API Key
# 3. Restrict to Distance Matrix API
```

## 4. Generate Secrets

```bash
# Application secret (token signing)
export NEXTAUTH_SECRET=$(openssl rand -hex 32)
echo "NEXTAUTH_SECRET=$NEXTAUTH_SECRET"

# API key (protects /api/agent/run and /api/ingest)
export MILA_USER_API_KEY=$(node -e "console.log(require('crypto').randomUUID())")
echo "MILA_USER_API_KEY=$MILA_USER_API_KEY"

# Cron secret (protects /api/cron/morning-brief)
export CRON_SECRET=$(openssl rand -hex 32)
echo "CRON_SECRET=$CRON_SECRET"

# Superadmin key (protects /superadmin dashboard)
export SUPERADMIN_KEY=$(openssl rand -hex 16)
echo "SUPERADMIN_KEY=$SUPERADMIN_KEY"
```

## 5. Configure Client

This is the core of the onboarding. Edit `src/config/client.ts` with the client's details.

```bash
$EDITOR src/config/client.ts
```

### Fields to fill in with the client:

```
client.name          → Full name (e.g., "Jan Novák")
client.company       → Company name (e.g., "RE/MAX Premium")
client.role          → Job title
client.email         → Primary email
client.phone         → Phone with country code
client.whatsapp      → WhatsApp number (digits + country code)

business.type        → Business category (e.g., "real_estate")
business.market      → Market description
business.specialization → What they focus on
business.typicalDealSize → { min, max, currency }
business.highValueSignals → Keywords that indicate a hot lead
business.lowPrioritySignals → Keywords for noise

ai.toneWithUser      → How Mila talks to the client
ai.toneWithCounterparties → How Mila talks to their contacts
ai.emailSignature    → Full email signature block
ai.systemContext     → The "day 1 briefing" for the AI assistant

leads.coolingThresholdDays → Days before "cooling" (default: 2)
leads.coldThresholdDays    → Days before "cold" (default: 5)
leads.deadThresholdDays    → Days before "dead" (default: 14)

calendar.personalEventKeywords → Words that mark personal events

scoring.offerMultiplierSeller → Priority boost for sell-side deals
scoring.offerMultiplierBuyer  → Priority for buy-side deals
```

### Tips for the client meeting:

- Ask: "What's the worst thing that happens if you don't reply to someone for 3 days?" — sets cooling threshold
- Ask: "What words in a message make you drop everything?" — sets highValueSignals
- Ask: "How do you sign your emails?" — copy their exact signature
- Ask: "What's a typical deal worth?" — sets typicalDealSize
- Write the systemContext as if briefing a new human assistant on their first day

## 6. Set Up Environment

```bash
# Copy the example
cp .env.example .env.local

# Fill in all values
cat > .env.local << 'EOF'
APP_BASE_URL=https://mila-clientname.vercel.app
NEXTAUTH_SECRET=<from step 4>
SUPABASE_URL=<from step 2>
SUPABASE_KEY=<anon key from step 2>
SUPABASE_SERVICE_KEY=<service key from step 2>
GOOGLE_CLIENT_ID=<from step 3>
GOOGLE_CLIENT_SECRET=<from step 3>
GOOGLE_MAPS_API_KEY=<from step 3>
GEMINI_API_KEY=<from step 3>
MILA_USER_API_KEY=<from step 4>
CRON_SECRET=<from step 4>
SUPERADMIN_KEY=<from step 4>
EOF

# Verify locally
npm install
npm run build
```

## 7. Create User in Supabase

```bash
# Generate a user ID
export USER_ID=$(node -e "console.log(require('crypto').randomUUID())")

# Insert via Supabase CLI or SQL editor:
```

```sql
INSERT INTO users (id, email, email_timezone, email_enabled, settings) VALUES (
  '<USER_ID>',
  'client@email.com',
  'Europe/Prague',
  true,
  '{
    "working_hours_start": 9,
    "working_hours_end": 17,
    "working_days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    "timezone": "Europe/Prague",
    "default_meeting_duration": 30,
    "default_meeting_type": "in_person",
    "meeting_buffer_minutes": 15,
    "travel_mode": "driving",
    "morning_brief_time": "08:00",
    "todo_auto_due_days": 1
  }'::jsonb
);
```

Adjust `working_hours_*`, `timezone`, `travel_mode`, `meeting_buffer_minutes` based on client preferences.

## 8. Deploy to Vercel

```bash
# Login
vercel login

# Deploy
vercel --prod

# Set environment variables
vercel env add NEXTAUTH_SECRET production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_KEY production
vercel env add SUPABASE_SERVICE_KEY production
vercel env add GOOGLE_CLIENT_ID production
vercel env add GOOGLE_CLIENT_SECRET production
vercel env add GOOGLE_MAPS_API_KEY production
vercel env add GEMINI_API_KEY production
vercel env add MILA_USER_API_KEY production
vercel env add CRON_SECRET production
vercel env add SUPERADMIN_KEY production
vercel env add APP_BASE_URL production
# Enter: https://mila-clientname.vercel.app

# Redeploy with env vars
vercel --prod
```

### Set Up Cron Job

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/morning-brief",
      "schedule": "0 6 * * *"
    }
  ]
}
```

The schedule is UTC. `0 6 * * *` = 6 AM UTC = 8 AM CET. Adjust for client's timezone.

## 9. Connect Google Account

```bash
# Open the OAuth connection page
open https://mila-clientname.vercel.app/auth/connect

# Client logs in with their Google account
# Grants Gmail + Calendar access
# Callback stores OAuth tokens in Supabase
```

## 10. Test the Pipeline

```bash
# Run the agent manually
curl -X POST https://mila-clientname.vercel.app/api/agent/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -d "{\"userId\": \"$USER_ID\"}"

# Check the response — should show emailsIngested, calendarEventsSynced, etc.

# Trigger a morning brief manually
curl https://mila-clientname.vercel.app/api/cron/morning-brief \
  -H "x-cron-secret: $CRON_SECRET"

# Check health
curl https://mila-clientname.vercel.app/api/health

# Check superadmin dashboard
open "https://mila-clientname.vercel.app/superadmin?key=$SUPERADMIN_KEY"
```

## 11. WhatsApp Setup (Optional)

WhatsApp requires a daemon process running on a server with a persistent session.

```bash
# Install WhatsApp dependencies (not in base package.json)
npm install whatsapp-web.js qrcode-terminal

# Set daemon env vars
export MILA_USER_ID=$USER_ID
export WA_DAEMON_PORT=3001
export WA_SESSION_PATH=./.wwebjs_auth

# Start the daemon
npx tsx scripts/whatsapp-daemon.ts

# First run: QR code appears in terminal
# Client scans QR with WhatsApp on their phone
# Session persists in .wwebjs_auth/

# Verify connection
curl http://localhost:3001/status
# Should show: { "connected": true, "phone": "+420..." }

# Test sending
curl -X POST http://localhost:3001/send \
  -H "Content-Type: application/json" \
  -d '{"to": "+420777000000", "body": "Test from Mila"}'
```

For production, run the daemon with a process manager:

```bash
# Using pm2
npm i -g pm2
pm2 start "npx tsx scripts/whatsapp-daemon.ts" --name mila-wa
pm2 save
pm2 startup
```

## 12. Sentry Setup (Optional)

```bash
# Create project at sentry.io
# Get DSN from Settings > Projects > Client Keys

vercel env add SENTRY_DSN production
vercel env add NEXT_PUBLIC_SENTRY_DSN production
vercel env add SENTRY_ORG production
vercel env add SENTRY_PROJECT production
vercel env add SENTRY_AUTH_TOKEN production

vercel --prod
```

## 13. Verify Everything

Final checklist:

```bash
# 1. Pipeline runs without errors
curl -s -X POST https://mila-clientname.vercel.app/api/agent/run \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\": \"$USER_ID\"}" | jq '.success'
# Expected: true

# 2. Morning brief sends
curl -s https://mila-clientname.vercel.app/api/cron/morning-brief \
  -H "x-cron-secret: $CRON_SECRET" | jq '.'

# 3. Client received the morning brief email
# Ask client to check inbox

# 4. Action links work (click APPROVE/EDIT in the brief email)

# 5. WhatsApp connected (if enabled)
curl -s https://mila-clientname.vercel.app/api/whatsapp/status | jq '.connected'
# Expected: true

# 6. Superadmin dashboard loads
open "https://mila-clientname.vercel.app/superadmin?key=$SUPERADMIN_KEY"
```

## Post-Setup

- Monitor Sentry for errors during the first week
- Check superadmin dashboard daily
- Fine-tune `leads` thresholds based on client feedback
- Adjust `highValueSignals` as you learn their business
- Add VIP contacts to counterparties with appropriate roles

## Updating Client Config

To change client settings after deployment:

```bash
cd mila-clientname
$EDITOR src/config/client.ts
npm run build          # Verify
git add src/config/client.ts
git commit -m "Update client config: <what changed>"
git push
vercel --prod          # Deploy
```

## Troubleshooting

| Problem | Check |
|---------|-------|
| Pipeline returns empty | Is OAuth connected? Check `users.google_oauth_tokens` is not null |
| No morning brief | Is `email_enabled: true`? Is cron schedule correct timezone? |
| WhatsApp disconnected | Restart daemon, re-scan QR. Check `.wwebjs_auth/` exists |
| Actions not generating | Check `conversation_threads` has entries. Check agent errors table |
| Draft generation fails | Check `GEMINI_API_KEY` is valid. Check Sentry for AI errors |
| Calendar not syncing | Verify Calendar API is enabled in Google Cloud Console |
| Travel time errors | Verify Distance Matrix API enabled + `GOOGLE_MAPS_API_KEY` set |
