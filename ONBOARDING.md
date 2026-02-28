# Onboarding a New User to Mila

How to go from zero to a fully working Mila instance for a new user. Every step is required unless marked optional.

---

## Prerequisites

Before you start, confirm these are in place:

1. **App is running** — either `npm run dev` locally or deployed on Vercel
2. **Supabase** — database provisioned with schema applied (see `docs/SCHEMA.md`)
3. **Environment variables** — set in `.env.local` (local) or Vercel dashboard (prod):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` — must be `https://<your-domain>/auth/callback` (and registered in Google Cloud Console under OAuth 2.0 credentials → Authorized redirect URIs)
   - `GEMINI_API_KEY` (or `GEMINI_API_KEYS` comma-separated for rotation)
   - `ANTHROPIC_API_KEY`
   - `MILA_USER_API_KEY`, `CRON_SECRET`, `NEXTAUTH_SECRET`
   - `QSTASH_TOKEN` (required for automated morning/afternoon briefs)
   - `APP_BASE_URL` — your app's public URL (e.g. `https://mila.specialagents.pro`). Defaults to `http://localhost:3000` if unset.
4. **Google OAuth consent screen** — configured in Google Cloud Console with Gmail + Calendar scopes

### Quick health check

```bash
curl http://localhost:3000/api/health
```

You should get `{"status":"ok"}`. If it says `degraded` or `error`, fix the missing env vars it reports before continuing.

---

## Step 1: Create the User

```bash
npx tsx scripts/add-user.ts
```

The script will:
1. Ask for the user's **email address**
2. Create a user record in Supabase and print a **UUID** — this is the user ID for all future commands
3. Print a **Google OAuth URL**

**Do this now:**
1. Copy the UUID and save it. You'll need it for every step below.
2. Open the OAuth URL in a browser. The user signs in with their Google account and grants Gmail + Calendar access.
3. After granting access, the browser redirects to `/auth/callback`. You should see a green "Connected!" screen. If you see an error, check that `GOOGLE_REDIRECT_URI` matches exactly what's in Google Cloud Console.

The script then asks "Configure user settings now?" — say **yes** to continue directly to Step 2.

---

## Step 2: Configure User Settings

If you said yes in Step 1, you're already here. Otherwise run:

```bash
npx tsx scripts/configure-user.ts --user-id <UUID>
```

The script walks through 7 sections interactively. Press Enter to accept the default (shown in brackets).

**Sections:**
1. **Client Identity** — name, company, role, phone
2. **Business Context** — business type, market, deal size range, currency
3. **AI Persona** — assistant name, language (e.g. `cs` for Czech, `en` for English), email signature
4. **Working Hours** — timezone, start/end hours, working days, brief time
5. **Meetings & Travel** — default duration, buffer, travel mode, home/office addresses
6. **Calendar** — business calendar (uses primary by default), optional personal calendar
7. **Advanced** — lead tracking thresholds, scoring multipliers, WhatsApp toggle

At the end, the script shows a preview of non-default settings and asks to confirm. After saving, it creates QStash schedules for morning and afternoon briefs (requires `QSTASH_TOKEN`).

**For automated/repeatable setup**, pass a JSON file instead:

```bash
npx tsx scripts/configure-user.ts --user-id <UUID> --from-json settings.json
```

---

## Step 3: Set Up Your Shell

Export the user ID so all subsequent commands can reference it:

```bash
export USER_ID="<UUID from Step 1>"
```

Load API keys from your `.env.local`:

```bash
source <(grep MILA_USER_API_KEY .env.local | head -1)
export CRON_SECRET=$(grep '^CRON_SECRET=' .env.local | cut -d '=' -f2- | tr -d '"' | tr -d "'")
```

> Add these to your `~/.bashrc` or `~/.zshrc` if you don't want to re-run them every session.

---

## Step 4: Import Historical Emails (Bulk Ingestion)

This pulls the user's email history so Mila has context about existing conversations and counterparties. Without this, Mila only knows about emails that arrive *after* setup — it would have no idea who the user's contacts are, what deals are in progress, or what conversations exist.

```bash
curl -X POST http://localhost:3000/api/ingest/bulk \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\", \"since\":\"2025-01-01\", \"maxTotal\":200}"
```

**Parameters you'll want to adjust:**

| Parameter | What it does | Examples |
|-----------|-------------|----------|
| `since` | How far back to fetch emails (ISO date) | `"2024-01-01"` for 1 year, `"2025-06-01"` for recent only |
| `until` | Stop date (optional, defaults to now) | `"2025-12-31"` to cap a range |
| `maxTotal` | Maximum number of emails to process | `50` for a quick test, `500` for a real setup, `5000` for full history |

**What to expect:**

- **Locally** (`localhost`): The response streams NDJSON progress lines to your terminal. You'll see emails being fetched, filtered, enriched, and threaded in real time. Rough timing:
  - 50 emails: ~2-5 minutes
  - 200 emails: ~10-20 minutes
  - 500 emails: ~30-60 minutes
  - 5000 emails: several hours
- **Production** (Vercel): Returns `202 Accepted` immediately. Work runs in the background via QStash worker chain (batches of 50 emails). No streaming output — check Vercel function logs for progress.

**Start small.** Run with `maxTotal: 50` first to confirm everything works, then run again with a larger number and an earlier `since` date to pull in more history.

After bulk ingestion completes, the user receives a "Welcome to Mila" backfill report email summarizing what was imported — conversations found, counterparties identified, and suggested actions.

---

## Step 5: Run the Agent Pipeline

Now run the full agent pipeline to process everything bulk ingestion brought in, plus pick up any new emails and calendar events:

```bash
curl -X POST http://localhost:3000/api/agent/run \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\"}"
```

**What it does (in order):**
1. Ingests new inbound + outbound emails (in parallel with calendar sync)
2. Threads messages into conversations
3. Generates action proposals (reply, follow up, schedule, delegate)
4. Scans for cooling/cold/dead leads

**What to expect:** Takes 1-3 minutes depending on how many unprocessed messages exist. Response is a JSON object with counts: `emailsIngested`, `calendarEventsSynced`, `conversationsUpdated`, `actionsGenerated`, etc.

---

## Step 6: Send a Brief

Trigger a morning brief to confirm the full loop works — emails were ingested, actions were proposed, and now the user gets a summary:

```bash
curl "http://localhost:3000/api/cron/morning-brief?userId=$USER_ID" \
  -H "Authorization: Bearer $CRON_SECRET"
```

The user should receive an email with their morning brief — a prioritized list of pending actions with approve/dismiss buttons.

For an afternoon brief:

```bash
curl "http://localhost:3000/api/cron/morning-brief?userId=$USER_ID&type=afternoon" \
  -H "Authorization: Bearer $CRON_SECRET"
```

**In production**, briefs are sent automatically by QStash at the times configured in Step 2. You don't need to curl them manually after onboarding.

---

## Step 7: Verify End-to-End

Send a real email to the user's Gmail address from a different account. Then run the agent again:

```bash
curl -X POST http://localhost:3000/api/agent/run \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\"}"
```

Check that:
- `emailsIngested` includes the new email
- `actionsGenerated` > 0 (Mila proposed a response)

Then send another brief to see the new action appear in the user's inbox.

The user is now fully onboarded. From here, QStash handles automated briefs, and you can trigger agent runs on a schedule or on-demand.

---

## Step 8 (Optional): Add WhatsApp

Only set this up after email + calendar are confirmed working.

### 8a. Install daemon dependencies

```bash
npm install @whiskeysockets/baileys pino qrcode-terminal
```

### 8b. Start the WhatsApp daemon

```bash
npx tsx scripts/whatsapp-daemon.ts
```

This starts a standalone process on port 3001. It stays running in the foreground — use a separate terminal or run it in a screen/tmux session. Uses ~5-10 MB per connected user.

### 8c. Connect the user's WhatsApp

```bash
# Start a session (returns 202)
curl -X POST http://localhost:3001/sessions/$USER_ID/connect

# Get the QR code
curl http://localhost:3001/status/$USER_ID
```

The response contains a `qrCode` field. The user scans it with their phone: WhatsApp → Settings → Linked Devices → Link a Device.

### 8d. Confirm connection

```bash
# Should show connected: true
curl http://localhost:3001/status/$USER_ID
```

### 8e. Enable WhatsApp in settings

```bash
npx tsx scripts/configure-user.ts --user-id $USER_ID --from-json <(echo '{"whatsapp_enabled": true}')
```

From this point, the agent pipeline picks up WhatsApp messages alongside email.

---

## Production Commands

Same commands as above, but against the production URL. Replace `http://localhost:3000` with `https://mila.specialagents.pro` (or your domain).

```bash
# Agent pipeline
curl -X POST "https://mila.specialagents.pro/api/agent/run" \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\"}"

# Bulk ingest (returns 202 — runs via QStash in background)
curl -X POST "https://mila.specialagents.pro/api/ingest/bulk" \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\", \"since\":\"2025-01-01\", \"maxTotal\":500}"

# Morning brief
curl "https://mila.specialagents.pro/api/cron/morning-brief?userId=$USER_ID" \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| `add-user.ts` fails with DB error | Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `.env.local` |
| OAuth "redirect_uri_mismatch" | `GOOGLE_REDIRECT_URI` must match exactly what's registered in Google Cloud Console |
| OAuth callback shows error | Make sure the app is running when you click the OAuth URL |
| Agent returns 401 | Check `MILA_USER_API_KEY` matches between `.env.local` and your curl header |
| Brief returns 401 | Check `CRON_SECRET` matches between `.env.local` and your Authorization header |
| Agent returns 0 emails ingested | User may not have completed OAuth (no Google tokens). Re-run Step 1's OAuth URL |
| Bulk ingest returns 202 but nothing happens | Production only — check Vercel function logs. Requires `QSTASH_TOKEN` |
| Bulk ingest streams but no emails found | Check the `since` date — it may be after the user's email history |
| No brief email received | Check user's `email_enabled` is true and `email_unsubscribed` is false in DB |
| QStash schedules not created | `QSTASH_TOKEN` must be set in `.env.local` before running `configure-user.ts` |

---

## API Quick Reference

All commands assume `$USER_ID` and `$MILA_USER_API_KEY` and `$CRON_SECRET` are set.

| What | Command |
|------|---------|
| Health check | `curl http://localhost:3000/api/health` |
| Run agent | `curl -X POST http://localhost:3000/api/agent/run -H "x-api-key: $MILA_USER_API_KEY" -H "Content-Type: application/json" -d "{\"userId\":\"$USER_ID\"}"` |
| Morning brief | `curl "http://localhost:3000/api/cron/morning-brief?userId=$USER_ID" -H "Authorization: Bearer $CRON_SECRET"` |
| Afternoon brief | `curl "http://localhost:3000/api/cron/morning-brief?userId=$USER_ID&type=afternoon" -H "Authorization: Bearer $CRON_SECRET"` |
| Manual ingest | `curl -X POST http://localhost:3000/api/ingest -H "x-api-key: $MILA_USER_API_KEY" -H "Content-Type: application/json" -d "{\"userId\":\"$USER_ID\"}"` |
| Bulk ingest | `curl -X POST http://localhost:3000/api/ingest/bulk -H "x-api-key: $MILA_USER_API_KEY" -H "Content-Type: application/json" -d "{\"userId\":\"$USER_ID\",\"since\":\"2025-01-01\",\"maxTotal\":500}"` |
| Superadmin | `curl "http://localhost:3000/api/superadmin/stats?key=$SUPERADMIN_KEY"` |
| GDPR export | `curl "http://localhost:3000/api/gdpr/export?userId=$USER_ID" -H "x-api-key: $MILA_USER_API_KEY"` |
| GDPR delete | `curl -X POST http://localhost:3000/api/gdpr/delete -H "x-api-key: $MILA_USER_API_KEY" -H "Content-Type: application/json" -d "{\"userId\":\"$USER_ID\"}"` |

### Auth Headers

| Endpoint | Auth | Header |
|----------|------|--------|
| `/api/agent/run` | API Key | `x-api-key: $MILA_USER_API_KEY` |
| `/api/ingest`, `/api/ingest/bulk` | API Key | `x-api-key: $MILA_USER_API_KEY` |
| `/api/cron/morning-brief` | Bearer | `Authorization: Bearer $CRON_SECRET` |
| `/api/action/[id]/*` | Token | `?token=<hmac>` (from email links) |
| `/api/superadmin/*` | Query | `?key=$SUPERADMIN_KEY` |
| `/api/gdpr/*` | API Key | `x-api-key: $MILA_USER_API_KEY` |
| `/api/health` | None | — |

### WhatsApp Daemon (port 3001)

| What | Command |
|------|---------|
| Daemon health | `curl http://localhost:3001/health` |
| List sessions | `curl http://localhost:3001/sessions` |
| User status | `curl http://localhost:3001/status/$USER_ID` |
| Connect | `curl -X POST http://localhost:3001/sessions/$USER_ID/connect` |
| Disconnect | `curl -X DELETE http://localhost:3001/sessions/$USER_ID` |
| Send message | `curl -X POST http://localhost:3001/send -H "Content-Type: application/json" -d '{"userId":"'$USER_ID'","to":"+420...","body":"Hello"}'` |

---

# User Settings Reference

All settings stored in `users.settings` JSONB column. Configured via `scripts/configure-user.ts`.

## Client Identity

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `client_name` | string | `""` | User's full name |
| `client_company` | string | `""` | Company name |
| `client_role` | string | `""` | Job title / role |
| `client_phone` | string | `""` | Phone number |
| `client_whatsapp` | string | `""` | WhatsApp number (may differ from phone) |

## Business Context

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `business_type` | string | `""` | e.g. "real estate", "consulting" |
| `business_market` | string | `""` | e.g. "Prague residential", "B2B SaaS" |
| `business_specialization` | string | `""` | Niche within market |
| `typical_deal_size_min` | number | `0` | Low end of deal range |
| `typical_deal_size_max` | number | `0` | High end of deal range |
| `typical_deal_size_currency` | string | `"CZK"` | Currency code |
| `high_value_signals` | string[] | `[]` | Keywords that flag high-value conversations |
| `low_priority_signals` | string[] | `[]` | Keywords that flag low-priority items |

## AI Persona

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ai_name` | string | `"Mila"` | Name of the AI assistant |
| `ai_language` | string | `"cs"` | Language code for drafts |
| `ai_email_signature` | string | `""` | Appended to email drafts |
| `ai_system_context` | string | `""` | Custom system prompt injected into AI calls |
| `ai_tone_user` | string | `"professional and concise"` | Tone when writing to the user |
| `ai_tone_cp` | string | `"polite and formal"` | Tone when writing to counterparties |
| `user_alias` | string | `"User"` | What Mila calls the user |

## Working Hours & Schedule

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `timezone` | string | `"Europe/Prague"` | IANA timezone |
| `working_hours_start` | number | `9` | Start of work day (0-23) |
| `working_hours_end` | number | `17` | End of work day (0-23) |
| `working_days` | number[] | `[1,2,3,4,5]` | Days of week (1=Mon, 7=Sun) |
| `morning_brief_time` | string | `"08:00"` | When to send the daily brief (HH:MM) |

## Meetings & Travel

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `default_meeting_duration` | number | `30` | Minutes |
| `default_meeting_type` | enum | `"online"` | `online`, `phone`, `office`, `walking` |
| `meeting_buffer_minutes` | number | `15` | Gap between meetings |
| `travel_mode` | enum | `"driving"` | `driving`, `walking`, `transit`, `bicycling` |
| `home_location` | string | `""` | Home address (for travel time) |
| `office_location` | string | `""` | Office address (for travel time) |

## Prioritization & Scoring

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `offer_multiplier_seller` | number | `1.5` | Priority boost when user is selling |
| `offer_multiplier_buyer` | number | `1.0` | Priority boost when user is buying |
| `priority_multiplier_vip` | number | `2.0` | Multiplier for VIP contacts |
| `kc_low_value` | number | `500000` | "Small deal" anchor for scoring |
| `kc_high_value` | number | `5000000` | "Big deal" anchor for scoring |
| `default_delegate_email` | string\|null | `null` | Email to delegate tasks to |
| `todo_auto_due_days` | number | `1` | Auto-set todo due date (days from now) |

## Lead Management

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cooling_threshold_days` | number | `2` | Days inactive before "cooling" |
| `cold_threshold_days` | number | `5` | Days inactive before "cold" |
| `dead_threshold_days` | number | `14` | Days inactive before "dead" |
| `max_auto_follow_ups` | number | `3` | Max auto follow-ups per conversation |
| `cooling_priority_boost` | number | `1.5` | Priority multiplier for cooling leads |
| `cold_priority_boost` | number | `2.5` | Priority multiplier for cold leads |
| `min_deal_value_for_tracking` | number | `0` | Minimum deal value for lead tracking (0 = all) |

## Calendar

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `business_calendar_id` | string | `"primary"` | Google Calendar ID |
| `personal_calendar_id` | string\|null | `null` | Personal calendar (blocks time, no actions) |
| `personal_event_keywords` | string[] | `["osobni", "personal", ...]` | Keywords identifying personal events |

## WhatsApp

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `whatsapp_enabled` | boolean | `false` | Enable WhatsApp processing |
| `whatsapp_session_data_path` | string | `"./baileys_auth"` | Baileys auth state directory |
| `whatsapp_daemon_port` | number | `3001` | Daemon HTTP port |
| `whatsapp_auto_ack_message` | string\|null | `null` | Auto-reply for incoming WA messages |
| `whatsapp_blocked_numbers` | string[] | `[]` | Phone numbers to ignore |
| `whatsapp_monitored_groups` | string[] | `[]` | WA group names to monitor (empty = skip all) |
