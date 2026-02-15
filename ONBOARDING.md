# Client Onboarding Guide

Deploy Mila for a new client. One Vercel deployment per client, configured via `src/config/client.ts`.

## Prerequisites

- Node.js 18+, npm
- Vercel CLI: `npm i -g vercel`
- Google Cloud Console access
- Access to the client (you need their email, phone, business details, email signature)

## 1. Google Cloud Project

Create a Google Cloud project for this client (or use an existing one).

### Enable APIs

In the Google Cloud Console, enable these three APIs:

- **Gmail API**
- **Google Calendar API**
- **Distance Matrix API**

### Create OAuth 2.0 Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Add Authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback` (development)
   - `https://<vercel-domain>/api/auth/callback` (production — add after first deploy)
5. Copy the **Client ID** and **Client Secret**

### Get a Gemini API Key

Go to https://aistudio.google.com/apikey, create one, copy it.

### Get a Maps API Key

In Google Cloud Console > APIs & Services > Credentials > Create API Key. Restrict it to Distance Matrix API.

## 2. Supabase Project

Create a project at https://supabase.com. Pick the region closest to the client.

From the project dashboard, copy:

- **Project URL** (Settings > API > Project URL)
- **anon/public key** (Settings > API > Project API Keys > anon)
- **service_role key** (Settings > API > Project API Keys > service_role)

### Enable pgvector

Run in the SQL Editor:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Apply Schema

Link and push migrations:

```bash
supabase link --project-ref <ref>
supabase db push
```

If not using migrations, apply the schema SQL directly in the SQL Editor. The tables are: `users`, `cps`, `channels`, `cp_states`, `conversation_threads`, `messages`, `thread_participants`, `message_embeddings`, `action_proposals`, `emails`, `todos`, `events`, `agent_errors`.

## 3. Generate Secrets

Run these locally, save the output — you need every value for `.env.local` and Vercel:

```bash
echo "NEXTAUTH_SECRET=$(openssl rand -hex 32)"
echo "MILA_USER_API_KEY=$(node -e "console.log(require('crypto').randomUUID())")"
echo "CRON_SECRET=$(openssl rand -hex 32)"
echo "SUPERADMIN_KEY=$(openssl rand -hex 16)"
```

## 4. Configure Environment

Create `.env.local` in the project root with all values from steps 1-3:

```
# App
APP_BASE_URL=http://localhost:3000
NEXTAUTH_SECRET=<generated in step 3>

# Supabase
SUPABASE_URL=<project URL from step 2>
SUPABASE_KEY=<anon key from step 2>
SUPABASE_SERVICE_KEY=<service_role key from step 2>

# Google
GOOGLE_CLIENT_ID=<OAuth client ID from step 1>
GOOGLE_CLIENT_SECRET=<OAuth client secret from step 1>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback
GOOGLE_MAPS_API_KEY=<Maps API key from step 1>

# AI
GEMINI_API_KEY=<Gemini key from step 1>

# Security
MILA_USER_API_KEY=<generated in step 3>
CRON_SECRET=<generated in step 3>
SUPERADMIN_KEY=<generated in step 3>
```

Every value comes from a specific prior step. Fill in every line.

Verify the build:

```bash
npm install
npm run build
```

Build must pass before proceeding.

## 5. Configure the Client

This is the core of onboarding. Open `src/config/client.ts` and fill in every field with the client's real details.

### What you need from the client

| Field | What to ask |
|-------|-------------|
| `client.name` | Full name |
| `client.company` | Company name |
| `client.role` | Job title |
| `client.email` | Primary Gmail/Google Workspace email |
| `client.phone` | Phone with country code (e.g. `+420777123456`) |
| `client.whatsapp` | WhatsApp number (same format) |
| `business.type` | Business category (`real_estate`, `consulting`, etc.) |
| `business.market` | Description of their market |
| `business.specialization` | What they focus on |
| `business.typicalDealSize` | `{ min, max, currency }` — ask "What's a typical deal worth?" |
| `business.highValueSignals` | Keywords that mean "drop everything" — ask "What words in a message make you stop what you're doing?" |
| `business.lowPrioritySignals` | Keywords for noise they don't care about |
| `ai.toneWithUser` | How Mila talks to them (formal/informal, name form) |
| `ai.toneWithCounterparties` | How Mila represents them externally |
| `ai.emailSignature` | Copy their exact email signature |
| `ai.systemContext` | Write this like a day-1 briefing for a new human assistant |
| `leads.coolingThresholdDays` | Ask "What's the worst that happens if you ignore someone for 3 days?" — calibrate from there |
| `leads.coldThresholdDays` | When does a lead start to feel lost? |
| `leads.deadThresholdDays` | When is it too late? |
| `calendar.personalEventKeywords` | Words that mark events as personal (gym, doctor, family, etc.) |
| `scoring.offerMultiplierSeller` | Boost for sell-side deals (default 1.5) |
| `scoring.offerMultiplierBuyer` | Baseline for buy-side deals (default 1.0) |

After editing, rebuild:

```bash
npm run build
```

## 6. Deploy to Vercel

```bash
vercel login
vercel --prod
```

After the first deploy, note the production domain (e.g. `mila-clientname.vercel.app`).

### Set environment variables

Set every variable from `.env.local` in Vercel, but with production values for `APP_BASE_URL` and `GOOGLE_REDIRECT_URI`:

```bash
vercel env add APP_BASE_URL production         # https://<vercel-domain>
vercel env add NEXTAUTH_SECRET production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_KEY production
vercel env add SUPABASE_SERVICE_KEY production
vercel env add GOOGLE_CLIENT_ID production
vercel env add GOOGLE_CLIENT_SECRET production
vercel env add GOOGLE_REDIRECT_URI production  # https://<vercel-domain>/api/auth/callback
vercel env add GOOGLE_MAPS_API_KEY production
vercel env add GEMINI_API_KEY production
vercel env add MILA_USER_API_KEY production
vercel env add CRON_SECRET production
vercel env add SUPERADMIN_KEY production
```

Also go back to Google Cloud Console and add `https://<vercel-domain>/api/auth/callback` as an authorized redirect URI on the OAuth credential.

Redeploy with the env vars:

```bash
vercel --prod
```

The cron job is already configured in `vercel.json` — morning brief runs at `0 8 * * *` UTC. Adjust the schedule in `vercel.json` for the client's timezone if needed.

## 7. Create the User

Use the script — it creates a user in Supabase and generates a Google OAuth URL:

```bash
npx tsx scripts/add-user.ts
```

This will:
1. Ask for the client's email address
2. Create a user record in Supabase
3. Print a user ID (save this)
4. Print a Google OAuth URL

The app must be running (`npm run dev`) or deployed for the OAuth callback to work.

Add the user ID to `.env.local` for the CLI scripts:

```bash
echo "MILA_USER_ID=<user-id-from-above>" >> .env.local
```

## 8. Connect Google Account

Open the OAuth URL printed by `scripts/add-user.ts` in a browser. The client logs in with their Google account, grants Gmail + Calendar access. The callback stores tokens in Supabase.

If doing this against the production deployment, the app must be deployed (step 6) and `GOOGLE_REDIRECT_URI` must match the production domain.

## 9. Test the Pipeline

Run the agent:

```bash
./scripts/run-agent.sh <user-id>
```

The response should show:

```json
{
  "success": true,
  "emailsIngested": 12,
  "calendarEventsSynced": 5,
  "messagesProcessed": 12,
  "conversationsUpdated": 8,
  "actionsGenerated": 3
}
```

To backfill historical emails, edit `scripts/bulk-ingest.sh` (set `USER_ID`, `API_KEY`, and date range), then run:

```bash
./scripts/bulk-ingest.sh
```

Run the health check:

```bash
./scripts/health-check.sh
```

Trigger the morning brief manually:

```bash
curl -s "${APP_BASE_URL}/api/cron/morning-brief" \
  -H "x-cron-secret: ${CRON_SECRET}" | python3 -m json.tool
```

Ask the client to check their inbox for the brief email.

Check the superadmin dashboard at `https://<vercel-domain>/superadmin?key=<SUPERADMIN_KEY>`.

## 10. WhatsApp Setup (Optional)

WhatsApp requires a daemon process running on a server with persistent sessions. This is separate from the Vercel deployment.

### Install dependencies

```bash
npm install whatsapp-web.js qrcode-terminal
```

These are not in `package.json` because the daemon runs outside Next.js.

### Start the daemon

```bash
export MILA_USER_ID=<user-id>
export WA_DAEMON_PORT=3001
export WA_SESSION_PATH=./.wwebjs_auth
npx tsx scripts/whatsapp-daemon.ts
```

On first run, a QR code appears in the terminal. The client scans it with WhatsApp on their phone. The session persists in `.wwebjs_auth/`.

### Verify

```bash
curl http://localhost:3001/status
# { "connected": true, "phone": "+420..." }

curl -X POST http://localhost:3001/send \
  -H "Content-Type: application/json" \
  -d '{"to": "+420777000000", "body": "Test from Mila"}'
```

### Keep it running in production

```bash
npm i -g pm2
pm2 start "npx tsx scripts/whatsapp-daemon.ts" --name mila-wa
pm2 save
pm2 startup
```

## 11. Sentry Setup (Optional)

Create a project at https://sentry.io, get the DSN.

```bash
vercel env add SENTRY_DSN production
vercel env add NEXT_PUBLIC_SENTRY_DSN production
vercel env add SENTRY_ORG production
vercel env add SENTRY_PROJECT production
vercel env add SENTRY_AUTH_TOKEN production
vercel --prod
```

## Post-Setup

- Monitor Sentry for errors during the first week
- Check superadmin dashboard daily
- Fine-tune `leads` thresholds based on client feedback
- Update `highValueSignals` as you learn their business patterns
- Run `./scripts/run-agent.sh` manually if the cron hasn't kicked in yet

## Scripts Reference

| Script | Purpose | Usage |
|--------|---------|-------|
| `scripts/add-user.ts` | Create user + generate OAuth URL | `npx tsx scripts/add-user.ts` |
| `scripts/run-agent.sh` | Trigger agent pipeline | `./scripts/run-agent.sh <user-id>` |
| `scripts/bulk-ingest.sh` | Backfill historical emails | Edit USER_ID/dates, then `./scripts/bulk-ingest.sh` |
| `scripts/health-check.sh` | Check app + DB + WA status | `./scripts/health-check.sh` |
| `scripts/whatsapp-daemon.ts` | WhatsApp Web bridge | `npx tsx scripts/whatsapp-daemon.ts` |

## Troubleshooting

| Problem | Check |
|---------|-------|
| Pipeline returns empty | Is OAuth connected? Check `users.google_oauth_tokens` is not null |
| No morning brief | Is `email_enabled: true` on the user? Is the cron schedule correct for the timezone? |
| WhatsApp disconnected | Restart daemon, re-scan QR. Check `.wwebjs_auth/` exists |
| Actions not generating | Check `conversation_threads` has entries. Check `agent_errors` table |
| Draft generation fails | Check `GEMINI_API_KEY` is valid. Check Sentry |
| Calendar not syncing | Verify Calendar API is enabled in Google Cloud Console |
| Travel time errors | Verify Distance Matrix API enabled + `GOOGLE_MAPS_API_KEY` set |
| OAuth callback fails | Check `GOOGLE_REDIRECT_URI` matches the URI in Google Cloud Console exactly |
| Build fails after client.ts edit | TypeScript error — check you didn't break the `as const` types |
