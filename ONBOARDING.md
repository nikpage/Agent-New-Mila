# Onboarding a New User to Mila

## Prerequisites

Before onboarding anyone, make sure the Mila instance is deployed and healthy:
- Next.js app running (Vercel or local)
- Supabase database provisioned with schema
- Environment variables set (see `.env.example` in CLAUDE.md)
- Google OAuth credentials configured (Client ID + Secret)

---

## Step 1: Create the User

```bash
npx tsx scripts/add-user.ts
```

Interactive prompts:
1. Enter the user's **email address**
2. Script creates the user record in Supabase (generates UUID)
3. Script generates a **Google OAuth URL** — open it in a browser
4. User signs in with Google, grants Gmail + Calendar access
5. OAuth callback stores tokens in DB automatically

> **Note:** The app must be running to handle the OAuth callback at `/auth/callback`.

---

## Step 2: Configure User Settings

The `add-user.ts` script will ask "Configure user settings now?" at the end. Say **yes** to proceed immediately, or run it later:

```bash
npx tsx scripts/configure-user.ts --user-id <uuid>
```

The script walks through 7 sections interactively. Press Enter to keep defaults.

For bulk/automated setup, pass a JSON file:

```bash
npx tsx scripts/configure-user.ts --user-id <uuid> --from-json settings.json
```

---

## Step 3: Verify Setup

```bash
# App health
curl https://your-mila-instance.com/api/health

# Run the agent pipeline once manually
curl -X POST https://your-mila-instance.com/api/agent/run \
  -H "x-api-key: $MILA_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "<uuid>"}'
```

Check that the response includes `emailsIngested`, `calendarEventsSynced`, etc.

---

## Step 4: Enable Cron

Set up the daily morning brief cron job (Vercel cron or external scheduler):

```
0 8 * * * curl -H "Authorization: Bearer $CRON_SECRET" https://your-mila-instance.com/api/cron/morning-brief
```

The user should receive their first morning brief email the next business day.

---

## Step 5 (Optional): Add WhatsApp

WhatsApp is an add-on channel. Only set up once the user is working correctly with email + calendar.

### 5a. Install daemon dependencies (once per server)

```bash
npm install @whiskeysockets/baileys pino qrcode-terminal
```

### 5b. Start the WhatsApp daemon (if not already running)

```bash
npx tsx scripts/whatsapp-daemon.ts
```

The daemon manages multiple users on a single process (~5-10 MB per session).

### 5c. Connect the user's WhatsApp session

```bash
# Initiate connection (returns 202)
curl -X POST http://localhost:3001/sessions/<userId>/connect

# Poll for QR code
curl http://localhost:3001/status/<userId>
```

The `qrCode` field contains the QR string. The user scans it with their phone's WhatsApp (Linked Devices > Link a Device).

### 5d. Confirm connection

```bash
# Should return connected: true, phone: "+420..."
curl http://localhost:3001/status/<userId>

# Also verify via the app
curl "https://your-mila-instance.com/api/whatsapp/status?userId=<userId>"
```

### 5e. Enable WhatsApp in user settings

Either re-run `configure-user.ts` and set WhatsApp to enabled in the Advanced section, or update directly:

```bash
npx tsx scripts/configure-user.ts --user-id <uuid> --from-json <(echo '{"whatsapp_enabled": true}')
```

From this point, the agent pipeline will pick up WhatsApp messages alongside email.

---

---

# User Settings Reference

All settings are stored in the `users.settings` JSONB column. Configured via `scripts/configure-user.ts` or directly in Supabase.

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
| `business_type` | string | `""` | e.g. "real estate", "consulting", "e-commerce" |
| `business_market` | string | `""` | e.g. "Prague residential", "B2B SaaS" |
| `business_specialization` | string | `""` | Niche within market |
| `typical_deal_size_min` | number | `0` | Low end of deal range |
| `typical_deal_size_max` | number | `0` | High end of deal range |
| `typical_deal_size_currency` | string | `"CZK"` | Currency code |
| `high_value_signals` | string[] | `[]` | Keywords that flag high-value conversations (e.g. "penthouse", "exclusive") |
| `low_priority_signals` | string[] | `[]` | Keywords that flag low-priority items (e.g. "newsletter", "unsubscribe") |

## AI Persona

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ai_name` | string | `"Mila"` | Name of the AI assistant |
| `ai_language` | string | `"cs"` | Language code for drafts (e.g. "cs", "en", "de") |
| `ai_email_signature` | string | `""` | Appended to email drafts |
| `ai_system_context` | string | `""` | Custom system prompt injected into AI calls |
| `ai_tone_user` | string | `"professional and concise"` | Tone when writing to the user (unused — see `client.ts`) |
| `ai_tone_cp` | string | `"polite and formal"` | Tone when writing to counterparties (unused — see `client.ts`) |
| `user_alias` | string | `"User"` | What Mila calls the user (unused — see `client.ts`) |

> **Note:** `ai_tone_user`, `ai_tone_cp`, and `user_alias` exist in the DB schema but are **not currently used**. AI persona is configured via `src/config/client.ts` instead.

## Working Hours & Schedule

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `timezone` | string | `"Europe/Prague"` | IANA timezone (e.g. "America/New_York", "Asia/Tokyo") |
| `working_hours_start` | number | `9` | Start of work day (24h format, 0-23) |
| `working_hours_end` | number | `17` | End of work day (24h format, 0-23) |
| `working_days` | number[] | `[1,2,3,4,5]` | Days of week (1=Mon, 7=Sun). e.g. `[1,2,3,4,5]` for Mon-Fri |
| `morning_brief_time` | string | `"08:00"` | When to send the daily brief email (HH:MM) |

## Meetings & Travel

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `default_meeting_duration` | number | `30` | Minutes |
| `default_meeting_type` | enum | `"online"` | One of: `online`, `phone`, `office`, `walking` |
| `meeting_buffer_minutes` | number | `15` | Gap between meetings |
| `travel_mode` | enum | `"driving"` | One of: `driving`, `walking`, `transit`, `bicycling` |
| `home_location` | string | `""` | Home address (for travel time calculation) |
| `office_location` | string | `""` | Office address (for travel time calculation) |

## Prioritization & Scoring

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `offer_multiplier_seller` | number | `1.5` | Priority boost when user is selling |
| `offer_multiplier_buyer` | number | `1.0` | Priority boost when user is buying |
| `priority_multiplier_vip` | number | `2.0` | Multiplier for VIP contacts |
| `kc_factor` | number | `13` | Fibonacci-based scoring constant |
| `default_delegate_email` | string\|null | `null` | Email to delegate tasks to |
| `todo_auto_due_days` | number | `1` | Auto-set todo due date (days from now) |

## Lead Management

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cooling_threshold_days` | number | `2` | Days inactive before "cooling" status |
| `cold_threshold_days` | number | `5` | Days inactive before "cold" status |
| `dead_threshold_days` | number | `14` | Days inactive before "dead" status |
| `max_auto_follow_ups` | number | `3` | Max automated follow-up messages per conversation |
| `cooling_priority_boost` | number | `1.5` | Priority multiplier for cooling leads |
| `cold_priority_boost` | number | `2.5` | Priority multiplier for cold leads |
| `min_deal_value_for_tracking` | number | `0` | Minimum deal value to trigger lead tracking (0 = track all) |

## Calendar

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `business_calendar_id` | string | `"primary"` | Google Calendar ID for business events |
| `personal_calendar_id` | string\|null | `null` | Google Calendar ID for personal events (blocks time, no actions) |
| `personal_event_keywords` | string[] | `["osobni", "personal", ...]` | Keywords that identify personal events |

## WhatsApp (Optional Add-On)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `whatsapp_enabled` | boolean | `false` | Enable WhatsApp message processing |
| `whatsapp_session_data_path` | string | `"./baileys_auth"` | Base directory for Baileys auth state |
| `whatsapp_daemon_port` | number | `3001` | HTTP port of the WhatsApp daemon |
| `whatsapp_auto_ack_message` | string\|null | `null` | Auto-reply message for incoming WA messages (null = disabled) |
| `whatsapp_blocked_numbers` | string[] | `[]` | Phone numbers to ignore (e.g. `["+420123456789"]`) |
| `whatsapp_monitored_groups` | string[] | `[]` | WhatsApp group names to monitor (empty = skip all groups) |
