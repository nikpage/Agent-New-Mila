# CLAUDE.md — Project Guide for Claude Code

## RULES

Role: Strict Senior Developer.

Propose plans; code ONLY after explicit approval.

Execute agreed logic exactly. Zero improvisation.

If logic is flawed: skip/flag minor issues, or halt for critical blockers.

Prioritize architecture. Never introduce tech debt for quick fixes.

Answer questions from what's already in context FIRST. Do NOT launch agents or read files to answer a question when the answer is visible in the conversation. Agents cost tokens — only use them when the information genuinely isn't available.

- NEVER modify expected values in pinning tests (files: `actions.test.ts`, `lead-tracking.test.ts`, `threading.test.ts`, `defaults.test.ts`, `action-card-disable.test.ts`, `instant-notify-grouping.test.ts`, `draft-payload.test.ts`, `address-inference.test.ts`). If a pinning test fails, REPORT the failure and WAIT. Do not update the test to match new output

## Base URLs & Testing
- **Local**: `http://localhost:3000`
- **Prod**: `https://mila.specialagents.pro/`

### Test commands (always local first, then prod)
```bash
# Local
curl "http://localhost:3000/api/cron/morning-brief?userId=ee23bcb7-ee2c-4e3f-a686-fb955ba0d753" -H "Authorization: Bearer $CRON_SECRET"

# Prod
curl "https://mila.specialagents.pro/api/cron/morning-brief?userId=ee23bcb7-ee2c-4e3f-a686-fb955ba0d753" -H "Authorization: Bearer $CRON_SECRET"
```

## Project Overview
Mila is an AI-powered executive assistant that ingests emails, WhatsApp messages, and calendar events, uses Gemini AI to propose actions (reply, schedule, follow up, delegate, snooze), tracks leads, and presents everything for user approval via morning brief emails.

- **Stack**: Next.js 14 (App Router) / TypeScript 5.7 (strict) / Supabase / Tailwind CSS 3
- **AI**: Google Gemini (primary) via @google/generative-ai + Anthropic Claude (fallback) via @anthropic-ai/sdk
- **Deployment**: Vercel (briefs scheduled via Upstash QStash)
- **Monitoring**: Sentry error tracking (client + server + edge)
- **Path alias**: `@/*` → `src/*`
- **Full product spec**: See SPEC.md

## Commands
```bash
npm run build        # Production build (the primary check — catches type errors + lint)
npm test             # Run Vitest test suite (~517 tests across 32 files)
npm run typecheck    # TypeScript only: tsc --noEmit
npm run lint         # ESLint via next lint
npm run dev          # Dev server (uses 8GB heap)
npm run test:watch   # Vitest in watch mode (re-runs on file change)
npm run test:coverage # Vitest with v8 coverage report
```

After making changes, run `npm test && npm run build` to verify nothing is broken.

## Performance Rules (CRITICAL)

### Do NOT bulk-read directories
Never read all files in a directory sequentially. This bloats context and causes hangs.

Worst offenders (do NOT read all files in these):
- `src/lib/db/` — 17+ files. Grep for the function you need.
- `src/services/` — 23+ files. Read only the service relevant to the task.
- `src/lib/google/` — 5 files, ~1600 lines. Read only the API you need.

### Do NOT follow imports into large type files
`src/lib/supabase/types.ts` (949 lines) — Only read if you need specific type definitions. Use Grep to find the type you need instead.

### Strategy for understanding code
1. Start with Grep to find the function/type you need
2. Read only the specific file containing it
3. Never read more than 2-3 files from the same directory in one session
4. If you need broader context, use the Explore agent — it manages its own context

## Import Hierarchy (CRITICAL)
`services/` → `shared/`, `lib/`, `config/`. Orchestrators (agent.ts, morning-brief.ts) import other services. **Peer services (planning, lead-tracking, threading, etc.) do NOT import from each other.** Shared pure functions live in `src/shared/`. If you need a function in two peer services, put it in `shared/`, not in one service and import from the other.

## Shared Business Logic (src/shared/)
Pure functions used by multiple services. Extracted to prevent circular regression loops.

- `scoring.ts` — `selectOfferMultiplier()`, `computeDaysIgnored()` (single source of truth for days-since-contact)
- `deal-types.ts` — `validateDealType()`

## Per-User Config
All user configuration is stored in `users.settings` JSONB column. See ONBOARDING.md for the full settings reference. Configured via `scripts/configure-user.ts`. `src/config/client.ts` exports helpers that take UserSettings: `getAISystemPrompt()`, `containsHighValueSignals()`, `isPersonalEvent()`. The `clientConfig` const in that file is legacy dead code.

## Priority Scoring
**Formula**: `Score = (nVal * sellerMultiplier) + (urgency * daysIgnored^1.5) + weight`

- **nVal** = `Math.max(1, Math.round((dollarValue / kcHighValue) * 10))`
- **sellerMultiplier** — 1.5 sellers, 1.0 buyers (via `selectOfferMultiplier()`)
- **urgency * daysIgnored^1.5** — time pressure (urgency 1-10, AI-assessed)
- **weight** — scheduling immovability (1-10, or 100 for immovable). Added flat to score

**Safe defaults**: urgency, sellerMultiplier fallback to 1 if 0/null. kcHighValue falls back to 5000000.

**DO NOT REMOVE OR CHANGE** the formula or wiring without explicit user permission.

**Urgency scale**: 10=now, 9=today, 8=tomorrow, 7=2d, 6=3d, 5=5d, 4=next week, 3=2 weeks, 1=none. Instant alert trigger: urgency >= 9.

**UDĚLAT button disable logic**: Only SCHEDULE actions can have UDĚLAT disabled (missing location or unfilled fields without hold). REPLY, TODO, and all other types are NEVER blocked.

## AI Model Configuration
- **Config**: `src/config/ai-models.ts` — 20 pipeline stages, each with 2-model fallback chain
- **Runner**: `src/lib/ai/runner.ts` — `runAITask(stage, prompt)`, auto-cascade on failure, retry 429/503
- **Rule**: Structured JSON output → Gemini. Czech prose output → Claude
- **Prompt language**: ALL prompts in English. Output language via `settings.ai_language` directive
- **Providers**: `src/lib/ai/providers/` — Gemini (multi-key rotation), Anthropic
- **Mila voice**: `src/lib/ai/mila-voice.ts` — ALL user-facing + CP-facing text generation

## Conventions
- All server-side code uses async/await with Supabase client
- Error handling: check error from Supabase responses, throw with descriptive messages
- API routes use Next.js App Router conventions (route.ts with exported HTTP method functions)
- Components use Tailwind CSS classes (no CSS modules)
- Type imports use `import type { ... }` syntax

## Testing
**Framework**: Vitest 4 with @/* path aliases. Tests co-located (foo.ts → foo.test.ts). Mock-Only-AI: mock AI + Google APIs, everything else runs real. Full inventory: See docs/TESTING.md

**Key rules**:
- Changed a function → update its pinning test
- Changed a default → update defaults.test.ts + field count
- New API route → add auth test in route-protection.test.ts
- Run `npm test` before every commit

## Security & Authentication
- **Google OAuth** proves identity via email ownership
- **API Key** (MILA_USER_API_KEY) — /api/agent/run, /api/ingest, /api/gdpr/*
- **Cron Secret** (CRON_SECRET) — /api/cron/*, /api/agent/dispatch
- **Action Token** (HMAC-signed) — /api/action/[id]/*
- **Superadmin Key** — /api/superadmin/*
- **Implementation**: `src/lib/auth/api.ts` → `verifyApiKey(request)`
- **RLS**: All tables have user_id — always filter by it in queries
- **DB security**: Always filter by user_id unless specifically needed

## Key Architectural Details (read code/docs when needed)
- **Agent pipeline**: `src/services/agent.ts` — Steps 0-7, parallel ingestion + graph walker. See code for full flow
- **Graph walker**: Step 4b (world model) + Step 5 (batch planner). Services: bypass-filter, deal-tagger, temporal-extractor, fact-extractor, reconstruction-critic, entity-map-updater, belief-log-updater, graph-updater, graph-walker, scoring-engine, card-generator
- **Scheduling**: `src/services/scheduling.ts` (1538 lines). Batch optimizer, slot finding (Prague TZ), travel time (Google Maps), hold events, conflict resolution
- **Threading**: `src/services/threading.ts` — external thread ID → CP count → density heuristic → AI
- **Briefs**: `src/services/morning-brief.ts` — AM/PM via QStash, quiet brief, instant notifications (urgency >= 9), action ordering (urgency-first, TODO suppresses CP action)
- **Lead tracking**: `src/services/lead-tracking.ts` — cooling/cold/dead detection, snooze bypass, service CP bypass, 3 follow-up cap
- **Deal timeline**: `src/lib/db/timeline.ts` — unified chronological table. Full spec: docs/DEAL-TIMELINE-SPEC.md
- **Bulk ingestion**: docs/BULK-INGESTION.md
- **WhatsApp**: docs/WHATSAPP.md — Baileys daemon, multi-session, channel resolution
- **Self-email commands**: docs/COMMANDS.md — "Mila:" subject prefix → AI-parsed → executed
- **Dispatcher**: docs/DISPATCHER-SPEC.md — Gmail history.list polling, QStash fan-out
- **Schema**: docs/SCHEMA.md — all tables, columns, migrations
- **Costs**: docs/COST-ESTIMATE.md

## Documentation Files
SPEC.md, SECURITY.md, ONBOARDING.md, docs/SCHEMA.md, docs/TESTING.md, docs/BULK-INGESTION.md, docs/WHATSAPP.md, docs/COMMANDS.md, docs/DEAL-TIMELINE-SPEC.md, docs/DISPATCHER-SPEC.md, docs/COST-ESTIMATE.md
