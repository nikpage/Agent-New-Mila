# Self-Email Commands

## Overview
Users can give Mila instructions by emailing themselves with a `Mila:` subject prefix. The command is intercepted during email ingestion, AI-parsed, and executed immediately. Results appear in the next morning/afternoon brief.

No new endpoints, no new UI, no new card types — just the existing email ingestion pipeline with a command parser added.

## How to Use

1. Compose an email **to yourself** (your connected Gmail address)
2. Subject: `Mila: <command>` (case-insensitive)
3. Body: freeform text describing what you want (AI-parsed)

**Rules:**
- Subject must **start** with `Mila:` — replies (`Re: Mila: ...`) and forwards (`Fwd: Mila: ...`) are ignored
- Body must not be empty
- Czech and English command aliases both work

**Examples:**
```
Subject: Mila: new contact
Body: Jan Novotný, jan@novotny.cz, +420 777 123 456, buyer at RE/MAX Premium

Subject: Mila: todo
Body: Call Novák about the Květinová contract, needs to be done by Friday

Subject: mila: kontakt
Body: Marie Procházková, prodávající, 608 555 123
```

## Supported Commands

### new contact
Creates or updates a counterparty in Mila's database.

**Aliases**: `new contact`, `contact`, `kontakt`, `nový kontakt`, `novy kontakt`

**AI extracts from body:**
| Field | Required | Notes |
|-------|----------|-------|
| name | Yes | Full name of the contact |
| email | No | Email address |
| phone | No | Normalized via `normalizePhoneNumber()`, stored in `other_identifiers.phones` |
| role | No | Validated: seller, buyer, landlord, tenant, agent, developer, other |
| company | No | Stored in CP's `locations.company` JSONB |

**Behavior:**
- **With email**: Uses `findOrCreateCP()` — dedup-safe, updates existing CP if found
- **Without email**: Creates CP with synthetic identifier `manual:<normalized-name>` (e.g., `manual:jan-novotny`)
- **Self-email rejected**: Cannot create yourself as a counterparty
- **Summary**: `"Kontakt vytvořen: Jan Novotný, jan@novotny.cz, +420777123456, buyer"`

### todo
Creates a task in Mila's todo list.

**Aliases**: `todo`, `task`, `úkol`, `ukol`

**AI extracts from body:**
| Field | Required | Notes |
|-------|----------|-------|
| description | Yes | What needs to be done |
| dueDate | No | ISO date — AI interprets relative dates ("tomorrow", "Friday", "next week") |

**Behavior:**
- Creates via `createTodo()` with status `'pending'`
- **Fallback**: If AI parse fails, the raw body text becomes the description (no due date)
- **Summary**: `"Úkol vytvořen: \"Call the notary\" (do: 2026-03-28)"`

## Architecture

### File Structure
```
src/lib/commands/
├── parser.ts      # isMilaCommand, classifyCommand, CommandParseError — pure functions, no I/O
├── executor.ts    # executeCommand — AI-parsed body, DB operations
└── index.ts       # Barrel re-export
```

### Detection & Classification (`parser.ts`)

**`isMilaCommand(subject)`** — Pure regex check: `/^mila:\s*/i`. Returns `true`/`false`. No I/O, safe as static import.

**`classifyCommand(subject, body)`** — Strips `Mila:` prefix, trims, matches against command aliases (exact match or prefix match with space). Returns `MilaCommandEmail { type, subject, body }`. Throws `CommandParseError` on unknown command or empty body.

**Command aliases** (defined in `COMMAND_ALIASES` map):
```typescript
'new_contact': ['new contact', 'contact', 'kontakt', 'nový kontakt', 'novy kontakt']
'todo':        ['todo', 'task', 'úkol', 'ukol']
```

### Execution (`executor.ts`)

**`executeCommand(command, userId, settings?)`** — AI-parses freeform body text via `runAITask('classify', ...)` (cheapest model stage: gemini-2.5-flash-lite → claude-haiku-4-5-20251001), then executes the appropriate DB operations.

Returns `CommandResult`:
```typescript
interface CommandResult {
  success: boolean
  commandType: MilaCommandType  // 'new_contact' | 'todo'
  summary: string               // Human-readable, Czech, shown in brief
  error?: string                // Error code on failure
}
```

**Reused functions:**
| Function | Source | Used by |
|----------|--------|---------|
| `runAITask('classify', ...)` | `lib/ai/runner.ts` | Both commands — freeform body parsing |
| `findOrCreateCP()`, `upsertCP()`, `updateCP()` | `lib/db/counterparties.ts` | new_contact |
| `normalizePhoneNumber()` | `lib/whatsapp/types.ts` | new_contact (phone normalization) |
| `createTodo()` | `lib/db/todos.ts` | todo |
| `writeAuditLog()` | `lib/db/gdpr.ts` | Audit trail (called from ingestion.ts) |

### Integration Point (`ingestion.ts:212-246`)

Commands are intercepted early in `processOneInboundEmail()`, after sender identification but before any email processing:

```
Email received
  ↓
Is sender the user? (isSameGmailAddress)
  ↓ Yes
Subject starts with "Mila:"? (isMilaCommand)
  ↓ Yes
classifyCommand(subject, body) → MilaCommandEmail
  ↓
executeCommand(parsed, userId, settings) → CommandResult
  ↓
Store as message (direction:'internal', tag_primary:'mila_command') — prevents re-processing
  ↓
writeAuditLog(action: 'command:<type>', details: { success, summary })
  ↓
return null — command emails never enter the normal pipeline
```

**Key design decisions:**
- `isMilaCommand` is a static import (pure regex, no I/O)
- `classifyCommand` and `executeCommand` are dynamically imported — only loaded when a command email is detected
- `messageExists()` check (line 198 in ingestion.ts) already prevents re-processing on subsequent agent runs
- Command emails always `return null` — they are never classified, enriched, threaded, or proposed as actions

### Brief Display (`morning-brief.ts:96-128`)

Successful commands executed in the last 24 hours appear in both normal and quiet briefs:

1. Query `audit_logs` where `action LIKE 'command:%'` AND `created_at > 24h ago` AND `action != 'command:error'`
2. Filter to `success: true` entries only (from `details` JSONB)
3. Render as **"Zpracované příkazy"** (Processed Commands) section
4. Type labels: `new_contact` → "Nový kontakt", `todo` → "Úkol"
5. Each item shows: `[typeLabel]: [summary]` with colored left border

## Error Handling

| Error | Source | Handling |
|-------|--------|----------|
| Unknown command (e.g., "Mila: dance") | `classifyCommand()` throws `CommandParseError` | Caught in ingestion, logged to audit as `command:error` |
| Empty body | `classifyCommand()` throws `CommandParseError` | Same as above |
| AI fails to parse body | `executeCommand()` returns `{ success: false }` | Logged to audit, not shown in brief |
| No name found (new_contact) | `executeCommand()` returns `{ success: false, error: 'no_name_found' }` | Same |
| Self-email as contact | `executeCommand()` returns `{ success: false, error: 'self_email' }` | Same |
| Non-command self-email | `isMilaCommand()` returns `false` | Falls through to existing `return null` (unchanged behavior) |

All errors are caught in `ingestion.ts` — command failures never crash the pipeline. `writeAuditLog()` never throws (by design in `gdpr.ts`).

## No Schema Changes

The feature uses existing columns with new string values:
- `messages.direction`: `'internal'` (new value — column is unconstrained string, not an enum)
- `messages.tag_primary`: `'mila_command'` (unconstrained string)
- `messages.tag_secondary`: `'new_contact'` | `'todo'` (unconstrained string)
- `messages.message_type`: `'command'` (unconstrained string)
- `cps.other_identifiers`: JSONB (existing, stores `{ phones: [...] }`)
- `cps.locations`: JSONB (existing, stores `{ company: '...' }`)
- `audit_logs`: existing table, used as-is

## Testing

**45 tests total** across 2 test files:

### `parser.test.ts` (32 tests)
- `isMilaCommand`: detects "Mila:" prefix, case-insensitive, rejects "Re:", "Fwd:", empty strings
- `classifyCommand`: all aliases (English + Czech), prefix matching ("Mila: todo call notary"), error cases
- `CommandParseError`: correct error messages for unknown commands and empty bodies

### `executor.test.ts` (13 tests)
- `new_contact`: AI-parsed CP creation with email, synthetic identifier fallback, phone/role/company updates, self-email rejection, duplicate detection
- `todo`: AI-parsed task creation, due date extraction, fallback to raw body on AI failure
- Error cases: missing name, AI parse failure, invalid JSON response

All tests mock AI (`runAITask`) and DB functions — no live API calls.

## V2 Planned

| Command | Purpose |
|---------|---------|
| `note` | Attach notes to existing CPs/conversations |
| `snooze` | Snooze a deal by name |
| `status` | Trigger immediate summary email back to user |
| `schedule` | Create meeting requests via email |
| WhatsApp channel | Send commands via WhatsApp (same parser) |
| Localized errors | Error messages in user's `ai_language` |
