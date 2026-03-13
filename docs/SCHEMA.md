# Database Schema Reference

## User Settings (JSONB)
Stored in `users.settings` column. Accessed via `getUserSettings(userId)`.

| Category | Fields | Defaults |
|----------|--------|----------|
| **Work Hours** | `working_hours_start`, `working_hours_end`, `working_days`, `timezone` | 9-17, Mon-Fri, Europe/Prague |
| **Meetings** | `default_meeting_duration`, `default_meeting_type`, `meeting_buffer_minutes` | 30m, online, 15m |
| **Travel** | `travel_mode`, `home_location`, `office_location` | driving |
| **Priorities** | `offer_multiplier_seller`, `offer_multiplier_buyer`, `priority_multiplier_vip`, `kc_low_value`, `kc_high_value` | 1.5, 1.0, 2.0, 500000, 5000000 |
| **AI Persona** | `ai_tone_user`, `ai_tone_cp`, `user_alias` | Professional, Polite, "User" |
| **Briefs** | `morning_brief_time`, `afternoon_brief_time` | 08:00, 13:00 |
| **Misc** | `default_delegate_email`, `todo_auto_due_days` | null, 1 |

**Note:** These settings are read at runtime via `getAISystemPrompt(settings)` in `src/config/client.ts`.

## Core Tables

**`users`** — id, email, mila_name, public_name, email_timezone, email_enabled, email_unsubscribed, settings (jsonb), google_oauth_tokens (jsonb), encrypted_google_tokens (text), created_at

**`cps`** (counterparties) — id, user_id, name, primary_identifier, other_identifiers (jsonb), role, locations (jsonb), is_blacklisted, created_at

**`channels`** — id, user_id, type (email/whatsapp), identifier, created_at

**`cp_states`** — cp_id → cps, state, summary_text, last_updated

## Conversation & Messages

**`conversation_threads`** — id, user_id, topic, summary_text, summary_json (jsonb), summary_confidence (numeric), summary_confidence_reason, messages_since_rebuild, message_count, state, deal_type, priority_score (integer), embedding (vector 768-dim), last_updated, created_at

**`messages`** — id, user_id, cp_id, channel_id, thread_id, conversation_id, external_thread_id, universal_message_id, external_id, direction (inbound/outbound), raw_text, cleaned_text, enriched_text, message_type (enum), tag_primary, tag_secondary, timestamp, occurred_at

**`thread_participants`** — thread_id, cp_id, added_at

**`message_embeddings`** — message_id, embedding (vector 768-dim)

## Actions & Execution

**`action_proposals`** — id, user_id, cp_id, conversation_id, action_type (REPLY/SCHEDULE/TODO/WAIT/ARCHIVE), status, rationale, rationale_cs, intent_cs, missing_info (jsonb), payload (jsonb), draft_subject, draft_body_text, user_notes, priority_score (numeric), dollar_value (numeric), urgency (numeric), pain_factor (numeric, DEAD — column exists but never read/written), weight (numeric), offer_multiplier (numeric), queued_for_brief, last_notified_at, created_at

**`emails`** (outbound send queue) — id, user_id, action_id, to, subject, text_body, html_body, status, external_id, sent_at, bounced, retry_count, last_retry_at, last_error, created_at, updated_at

**`todos`** — id, user_id, cp_id, thread_id, description, status, due_date, scheduled_time, created_at

## Calendar

**`events`** — id, user_id, cp_id, title, description, location, start_time, end_time, event_type (meeting/travel_buffer), status, parent_event_id (self-ref for travel buffers), pre_block_group_id, google_event_id, created_at

## GDPR & Audit

**`audit_logs`** — id, user_id (FK SET NULL — survives user deletion), action, details (jsonb), ip_address, created_at

## Concurrency

**`user_agent_locks`** — user_id (PK, FK CASCADE), locked_at, expires_at (10-min TTL auto-expiry)

## System

**`agent_errors`** — id, user_id, error_id, agent_type, message_internal, message_user, created_at

## Known Redundancy / Unused Columns
- `messages.thread_id` AND `messages.conversation_id` — both FK to `conversation_threads` (redundant)
- `users.google_oauth_tokens` (jsonb) AND `users.encrypted_google_tokens` (text) — migration in progress
- `conversation_threads.priority_score` — integer on thread vs numeric on action_proposals (different scales)
- `users.settings.ai_tone_user/ai_tone_cp/user_alias` — used at runtime via `getAISystemPrompt(settings)` in `client.ts`

## Deal Property Model
- **`conversation_threads.deal_type`** — set by AI during planning (`proposeAction` → `planning.ts`). Values: `sale`, `purchase`, `rental`, `lease`, `consultation`, `other`, or `null`. Type: `DealType` in `types.ts`.
- **`action_proposals.offer_multiplier`** — set during planning from user settings based on CP role. `cp.role === 'seller'` → `offer_multiplier_seller` (default 1.5), otherwise `offer_multiplier_buyer` (default 1.0). Flows into `calculatePriorityScore()`.
- **`action_proposals.dollar_value`** — AI estimates in user's configured currency (from `typical_deal_size_currency`, default CZK). High-value signal detection (`containsHighValueSignals`) flags conversations for the AI to prioritize estimation.
- **CP `role`** — typed as `CPRole`: `seller`, `buyer`, `landlord`, `tenant`, `agent`, `developer`, `other`, or `null`.
- **`payload.action_metadata`** — includes `deal_type`, `offer_multiplier`, `weight`, and `is_high_value` boolean for downstream consumers.

## Required Migrations

### Audit Logs
```sql
CREATE TABLE audit_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb,
  ip_address text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
```

### Agent Locks + Message Enrichment
```sql
CREATE TABLE user_agent_locks (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  locked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- Per-message enrichment (enriched key info extracted by AI)
ALTER TABLE messages ADD COLUMN enriched_text text;
CREATE INDEX idx_messages_enriched_null
  ON messages (user_id, created_at)
  WHERE enriched_text IS NULL;
```
