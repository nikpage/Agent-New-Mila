# CLAUDE.md — Project Guide for Claude Code

## Project Overview
**Mila** is an AI-powered executive assistant that ingests emails/calendars via Google Workspace APIs, uses Gemini AI to propose actions (reply, schedule, wait, delegate), and presents them for user approval.

- **Stack**: Next.js 14 (App Router) / TypeScript 5.7 (strict) / Supabase / Tailwind CSS 3
- **AI**: Google Generative AI (Gemini) via `@google/generative-ai`
- **Deployment**: Vercel with cron jobs
- **Path alias**: `@/*` → `src/*`

## Commands
```bash
npm run build        # Production build (the primary check — catches type errors + lint)
npm run typecheck    # TypeScript only: tsc --noEmit
npm run lint         # ESLint via next lint
npm run dev          # Dev server (uses 8GB heap)
```
**Always run `npm run build` after making changes** to verify nothing is broken. If build passes, the code is good.

## Architecture Map

```
src/
├── app/                        # Next.js App Router (pages + API routes)
│   ├── api/agent/run/          # Main agent orchestration endpoint
│   ├── api/action/[id]/        # Action CRUD + execute/draft/todo/blacklist
│   ├── api/auth/               # OAuth connect + callback
│   ├── api/cron/morning-brief/ # Daily 8 AM cron
│   ├── api/ingest/             # Manual email/calendar ingestion
│   ├── api/health/             # Health check
│   ├── action/[id]/            # Action detail + edit pages
│   └── page.tsx                # Home/status dashboard
│
├── services/                   # Business logic (orchestration layer)
│   ├── agent.ts                # Main pipeline (~120 lines)
│   ├── scheduling.ts           # Calendar slot finding (683 lines) ⚠️ LARGEST
│   ├── planning.ts             # Action generation (235 lines)
│   ├── threading.ts            # Email conversation grouping (306 lines)
│   ├── ingestion.ts            # Email ingestion (225 lines)
│   ├── calendar-ingestion.ts   # Calendar sync (297 lines)
│   └── morning-brief.ts        # Daily summary (212 lines)
│
├── lib/                        # Shared utilities & integrations
│   ├── db/                     # Supabase CRUD — 9 files, 1892 lines total
│   ├── google/                 # Google APIs — calendar, gmail, auth, maps
│   ├── supabase/               # Client + types (types.ts = 593 lines)
│   ├── ai/gemini.ts            # Gemini AI calls (228 lines)
│   ├── auth/tokens.ts          # OAuth token management
│   └── holidays.ts             # Holiday calendar
│
├── components/                 # React components
│   ├── action/ActionCard.tsx   # Main action UI (337 lines)
│   ├── action/EditForm.tsx     # Action editor (142 lines)
│   └── ui/                     # Button, Card, Badge, Input
│
└── config/
    ├── env.ts                  # Environment config with validation
    └── theme.ts                # Design tokens
```

## Performance Rules (CRITICAL)

### Do NOT bulk-read directories
Never read all files in a directory sequentially. This bloats context and causes hangs.

**Worst offenders (do NOT read all files in these):**
- `src/lib/db/` — 9 files, 1892 lines. Use the index below to pick the right file.
- `src/services/` — 8 files, 2000+ lines. Read only the service relevant to the task.
- `src/lib/google/` — 5 files, 1100+ lines. Read only the API you need.

### Do NOT follow imports into large type files
- `src/lib/supabase/types.ts` (593 lines) — Only read if you need specific type definitions. Use Grep to find the type you need instead.

### Strategy for understanding code
1. **Start with Grep** to find the function/type you need
2. **Read only the specific file** containing it
3. **Never read more than 2-3 files** from the same directory in one session
4. If you need broader context, use the Explore agent — it manages its own context

## src/lib/db/ Quick Reference
Instead of reading these files, use this index:

| File | Lines | Contents |
|------|-------|----------|
| `users.ts` | 146 | `getUserById`, `getUserByEmail`, `createUser`, `updateUser`, `getUserSettings`, `updateUserSettings` |
| `counterparties.ts` | 203 | `getCPById`, `getCPByIdentifier`, `createCP`, `updateCP`, `getCPsForUser` |
| `conversations.ts` | 289 | `getConversationById`, `createConversation`, `updateConversation`, `getConversationsForUser`, `addParticipant` |
| `messages.ts` | 222 | `getMessageById`, `createMessage`, `getMessagesForConversation`, `getRecentMessages` |
| `actions.ts` | 288 | `getActionById`, `createAction`, `updateAction`, `getActionsForUser`, `calculatePriorityScore` |
| `todos.ts` | 206 | `getTodoById`, `createTodo`, `updateTodo`, `getTodosForUser` |
| `events.ts` | 439 | `getEventById`, `createEvent`, `updateEvent`, `getEventsForUser`, `getEventsInRange` |
| `embeddings.ts` | 91 | `saveMessageEmbedding`, `searchSimilarMessages` |
| `index.ts` | 8 | Barrel re-exports (do not read — it just re-exports the above) |

All db files follow the same pattern: import `getSupabaseAdmin` from `../supabase/client`, import types from `../supabase/types`, export async CRUD functions.

## Database Tables (so you don't need to read types.ts)

## User Settings (JSONB)
Stored in `users.settings` column. Accessed via `getUserSettings(userId)`.

| Category | Fields | Defaults |
|----------|--------|----------|
| **Work Hours** | `working_hours_start`, `working_hours_end`, `working_days`, `timezone` | 9-17, Mon-Fri, Europe/Prague |
| **Meetings** | `default_meeting_duration`, `default_meeting_type`, `meeting_buffer_minutes` | 30m, online, 15m |
| **Travel** | `travel_mode`, `home_location`, `office_location` | driving |
| **Priorities** | `offer_multiplier_seller`, `offer_multiplier_buyer`, `priority_multiplier_vip`, `kc_factor` | 1.5, 1.0, 2.0, 13 |
| **AI Persona** | `ai_tone_user`, `ai_tone_cp`, `user_alias` | Professional, Polite, "User" |
| **Misc** | `morning_brief_time`, `default_delegate_email`, `todo_auto_due_days` | 08:00, null, 1 |


| Table | Key columns |
|-------|------------|
| `users` | id, email, name, google_tokens, settings (jsonb), timezone |
| `cps` | id, user_id, name, email, identifiers[], role, location, state |
| `conversation_threads` | id, user_id, subject, summary, gmail_thread_id, last_message_at |
| `messages` | id, thread_id, from/to/cc, subject, body, gmail_message_id, date |
| `action_proposals` | id, user_id, thread_id, type (REPLY/SCHEDULE/WAIT/FILE/DELEGATE), status, priority_score, draft_content |
| `events` | id, user_id, title, start/end, location, attendees[], google_event_id, event_type |
| `todos` | id, user_id, title, description, status, due_date |
| `message_embeddings` | message_id, embedding (vector) |

## Conventions
- All server-side code uses `async/await` with Supabase client
- Error handling: check `error` from Supabase responses, throw with descriptive messages
- API routes use Next.js App Router conventions (`route.ts` with exported HTTP method functions)
- Components use Tailwind CSS classes (no CSS modules)
- Type imports use `import type { ... }` syntax
- No test framework is configured — verify changes with `npm run build`


## Superadmin
- Dashboard at `/superadmin`
- Protected by `SUPERADMIN_KEY` env var (passed via `?key=` or header)
- Shows system health, user stats, and error logs
