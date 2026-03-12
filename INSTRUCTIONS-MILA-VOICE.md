# Instructions: Create mila-voice.ts and wire it up

## What this is

Mila's user-facing and CP-facing text is currently scattered across 3 files with hardcoded Czech strings. We're centralizing ALL of Mila's text generation into one new module: `src/lib/ai/mila-voice.ts`.

## Tests already written

`src/lib/ai/mila-voice.test.ts` — 28 tests. They all fail right now. Your job is to make them pass. Run `npm test` after each step.

## Rules

- Do NOT modify expected values in pinning tests (`actions.test.ts`, `lead-tracking.test.ts`, `threading.test.ts`, `defaults.test.ts`). If a pinning test fails, STOP and report.
- Do NOT change the AI prompts in `gemini.ts` for `proposeAction()`, `analyzeConversation()`, `enrichMessage()`, etc. — those stay where they are.
- All new AI calls use stage `'drafting'` via `runAITask()`.
- All prompts are written in English. Czech output is requested via explicit directives.
- Every function receives `UserSettings` and uses `settings.ai_tone_user` or `settings.ai_tone_cp` in the prompt.

---

## Step 1: Create `src/lib/ai/mila-voice.ts`

Create the file with these 5 exported functions. Each makes one `runAITask('drafting', prompt)` call.

### 1a. `generateSchedulingIntent()`

```typescript
export async function generateSchedulingIntent(
  originalIntent: string,
  scheduling: {
    slotText: string              // e.g. "pondělí 17. března, 09:00 - 09:30"
    hasConflicts: boolean
    conflicts?: { name: string; recommendation: 'move_existing' | 'suggest_alternate' }[]
    hasHold: boolean
    locationStatus: 'confirmed' | 'partial' | 'missing' | null
    locationText?: string | null
  },
  cpName: string,
  urgency: number,
  settings: UserSettings
): Promise<{ intent_cs: string; missingInfo: { label: string; value: null }[] }>
```

**Prompt logic:**
- Receives the AI's original `intent_cs` from `proposeAction()` and the scheduling result
- Tells the AI: "Rewrite this intent incorporating the scheduling details. Keep the original context and add the slot/conflict/location info naturally."
- Includes `settings.ai_tone_user` in prompt
- Includes urgency: "Urgency is {N}/10. Adjust your tone — 9-10 is house on fire, 1-3 is routine."
- AI returns JSON: `{ "intent_cs": "...", "missingInfo": [...] }`
- If `locationStatus === 'missing'`, AI should include a question about location in missingInfo
- If `locationStatus === 'partial'`, AI should include a question to clarify the location
- If scheduling has no slot (no hold), AI should include a question asking for preferred time

### 1b. `generateLeadFollowUpIntent()`

```typescript
export async function generateLeadFollowUpIntent(
  status: 'cooling' | 'cold' | 'dead',
  cpName: string,
  daysSinceActivity: number,
  topic: string,
  channel: string,
  followUpNumber: number,
  settings: UserSettings
): Promise<{ intentCs: string; rationaleCs: string }>
```

**Prompt logic:**
- Tells the AI: "You are Mila. A lead has gone {status}. Write intent_cs (what you'll do) and rationale_cs (why it matters now)."
- Passes: CP name, days inactive, conversation topic, channel, follow-up number
- Includes `settings.ai_tone_user` in prompt
- Urgency implicit from status: dead = very urgent, cooling = gentle
- AI returns JSON: `{ "intentCs": "...", "rationaleCs": "..." }`

### 1c. `generateBriefIntro()`

```typescript
export async function generateBriefIntro(
  briefType: 'morning' | 'afternoon',
  actionCount: number,
  events: { title: string; time: string }[],
  pendingActions: { type: string; cpName: string; urgency: number }[],
  settings: UserSettings
): Promise<{ greeting: string; subject: string; headline: string }>
```

**Prompt logic:**
- Tells the AI: "You are Mila writing a {briefType} brief email. Generate greeting, email subject line, and a 2-3 sentence headline."
- Morning → greeting should reflect morning. Afternoon → afternoon. Do NOT hardcode "Dobré ráno" — let the AI write it naturally.
- Subject should be concise, include action count naturally (not "Mila: 3 navrhované akce" template)
- Headline summarizes the day — same as current `generateBriefHeadline()` but also returns greeting and subject
- Includes `settings.ai_tone_user`
- AI returns JSON: `{ "greeting": "...", "subject": "...", "headline": "..." }`

### 1d. `generateUrgentIntro()`

```typescript
export async function generateUrgentIntro(
  actionCount: number,
  topAction: { cpName: string; urgency: number; actionType: string },
  settings: UserSettings
): Promise<{ subject: string; header: string; body: string }>
```

**Prompt logic:**
- Tells the AI: "You are Mila sending an urgent notification. Generate email subject, header text, and a one-sentence body."
- Urgency is always high here (score > 79) — tone should reflect that
- Includes `settings.ai_tone_user`
- AI returns JSON: `{ "subject": "...", "header": "...", "body": "..." }`

### 1e. `generateFinalDraft()`

**Move** the existing `generateFinalDraft()` function from `src/lib/ai/gemini.ts` to `src/lib/ai/mila-voice.ts`. Keep the exact same logic, parameters, and prompt. The only change: it already uses `settings.ai_tone_cp` via `getAISystemPrompt(settings)` — that's correct, keep it.

---

## Step 2: Wire planning.ts

File: `src/services/planning.ts`

### What to change (lines 234-297):

The current code has three branches after `proposeMeeting()` returns — each overwrites `proposal.intent_cs` with hardcoded Czech. Replace all three branches with a single call to `generateSchedulingIntent()`.

**Before** (lines 219-297 approximately):
```
if (schedulingResult.holdEvent) {
  // ... format slot text ...
  if (hasConflicts && hasImmovableConflict) {
    proposal.intent_cs = "hardcoded..."  // DELETE
    proposal.missingInfo = []             // DELETE
  } else if (hasConflicts) {
    proposal.intent_cs = "hardcoded..."  // DELETE
    proposal.missingInfo = []             // DELETE
  } else {
    proposal.intent_cs = "hardcoded..."  // DELETE
    proposal.missingInfo = []             // DELETE
  }
  // hardcoded missingInfo pushes          // DELETE
} else {
  // hardcoded missingInfo push            // DELETE
}
```

**After:**
```typescript
import { generateSchedulingIntent } from '@/lib/ai/mila-voice'

// ... inside the if (schedulingResult.holdEvent) block ...

if (schedulingResult.holdEvent) {
  const hold = schedulingResult.holdEvent
  const start = new Date(hold.start_time)
  const end = new Date(hold.end_time)
  const tz = 'Europe/Prague'
  const dateStr = start.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })
  const startStr = start.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const endStr = end.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  const slotText = `${dateStr}, ${startStr} - ${endStr}`

  const conflicts = schedulingResult.conflicts?.map(c => ({
    name: c.existingEvent.title || 'existing event',
    recommendation: c.recommendation,
  }))

  let locationStatus: 'confirmed' | 'partial' | 'missing' | null = null
  if (!meetingLocation) locationStatus = 'missing'
  else if (locationPartial) locationStatus = 'partial'
  else locationStatus = 'confirmed'

  const voiceResult = await generateSchedulingIntent(
    proposal.intent_cs,
    {
      slotText,
      hasConflicts: !!(conflicts && conflicts.length > 0),
      conflicts,
      hasHold: true,
      locationStatus,
      locationText: meetingLocation,
    },
    cp.name || cp.primary_identifier,
    proposal.urgency,
    settings
  )

  proposal.intent_cs = voiceResult.intent_cs
  proposal.missingInfo = voiceResult.missingInfo

  // Keep the urgency boost for immovable conflicts
  const hasImmovableConflict = schedulingResult.conflicts?.some(
    c => c.recommendation === 'suggest_alternate'
  )
  if (hasImmovableConflict) {
    proposal.urgency = Math.max(proposal.urgency, 9)
  }

} else {
  // No hold — no free slots found
  const voiceResult = await generateSchedulingIntent(
    proposal.intent_cs,
    {
      slotText: '',
      hasConflicts: false,
      hasHold: false,
      locationStatus: null,
    },
    cp.name || cp.primary_identifier,
    proposal.urgency,
    settings
  )
  proposal.intent_cs = voiceResult.intent_cs
  proposal.missingInfo = voiceResult.missingInfo
}
```

**Keep unchanged:** Everything before line 219 (the proposeAction call, channel detection, etc.) and everything after line 297 (priority score calculation, createAction call). The `schedulingPayload` object building (lines 271-284) stays — just remove the old intent/missingInfo overwrites inside the if/else branches.

---

## Step 3: Wire morning-brief.ts

File: `src/services/morning-brief.ts`

### 3a. Replace greeting + headline + subject (lines 93-136)

**Add import:**
```typescript
import { generateBriefIntro, generateUrgentIntro } from '@/lib/ai/mila-voice'
```

**Remove import:**
```typescript
import { generateBriefHeadline } from '@/lib/ai/gemini'
```

**Replace lines 93-136** (the headline generation + greeting + subject) with:

```typescript
let greeting: string
let headline: string
let briefSubject: string
try {
  const intro = await generateBriefIntro(
    briefType,
    briefActions.length,
    events.map(e => ({
      title: e.title || 'Event',
      time: new Date(e.start_time).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: user.email_timezone,
      }),
    })),
    briefActions.map(b => ({
      type: b.action.action_type,
      cpName: b.cpName,
      urgency: b.action.urgency,
    })),
    await getUserSettings(userId)
  )
  greeting = intro.greeting
  headline = intro.headline
  briefSubject = intro.subject
} catch (introError) {
  console.error(`[MorningBrief] Brief intro generation failed for user ${userId}, using fallback:`, introError)
  greeting = briefType === 'morning' ? 'Dobré ráno' : 'Dobré odpoledne'
  headline = `Máte ${briefActions.length} akčních návrhů ke zpracování.`
  briefSubject = `Mila: ${briefActions.length} akcí`
}
```

Then update the `sendEmail` call to use `briefSubject` instead of the old computed subject:
```typescript
await sendEmail(userId, {
  to: userEmail,
  subject: briefSubject,
  body: textContent,
  htmlBody: htmlContent,
})
```

**Delete** the old `subjectCount`/`subjectText` computation (lines 131-132).

**Note:** You'll need to import `getUserSettings` from `@/lib/db/users` (it may already be imported via other paths — check first).

### 3b. Replace instant notification text (lines 367-407)

In `sendInstantNotificationForUser()`, replace the hardcoded subject (lines 372-374):

```typescript
const settings = await getUserSettings(userId)
let urgentSubject: string
let urgentHeader: string
let urgentBody: string
try {
  const topAction = briefActions[0]
  const intro = await generateUrgentIntro(
    briefActions.length,
    { cpName: topAction.cpName, urgency: topAction.action.urgency, actionType: topAction.action.action_type },
    settings
  )
  urgentSubject = intro.subject
  urgentHeader = intro.header
  urgentBody = intro.body
} catch {
  urgentSubject = `⚡ Mila: ${briefActions.length === 1 ? 'urgentní akce' : `${briefActions.length} urgentní akce`}`
  urgentHeader = '⚡ Urgentní akce'
  urgentBody = `Máte ${briefActions.length === 1 ? 'novou vysoce prioritní akci' : `${briefActions.length} nové vysoce prioritní akce`} k okamžitému zpracování.`
}
```

Then pass `urgentSubject` to `sendEmail`, and pass `urgentHeader` + `urgentBody` to `generateInstantNotifyEmailHtml`.

Update `generateInstantNotifyEmailHtml` signature to accept `header` and `body` params instead of hardcoding them:
```typescript
function generateInstantNotifyEmailHtml(actions: BriefAction[], header: string, body: string): string {
```

And use `header`/`body` in the HTML instead of the hardcoded strings on lines 406-407.

Same for `generateInstantNotifyEmailText` — accept `header` param, use it instead of hardcoded `'⚡ URGENTNÍ AKCE'`.

**IMPORTANT:** The fallback (catch block) keeps hardcoded Czech as graceful degradation if the AI call fails. This is intentional — the tests check that the NON-FALLBACK path uses mila-voice. The fallback strings are acceptable because they only fire on AI failure.

Wait — re-reading the tests, they check that the file does NOT contain strings like `'urgentní akce'` at all. So the fallback needs to NOT use those exact strings either. Use generic fallbacks:
```typescript
} catch {
  urgentSubject = `⚡ Mila`
  urgentHeader = '⚡'
  urgentBody = ''
}
```

Actually no — let me re-read the test... The test checks `expect(code).not.toContain('urgentní akce')`. A string in a catch fallback would still be in the code. So the fallback must avoid those exact Czech strings. Use minimal fallbacks:
```typescript
} catch {
  urgentSubject = `Mila — ${briefActions.length}`
  urgentHeader = 'Mila'
  urgentBody = ''
}
```

---

## Step 4: Wire lead-tracking.ts

File: `src/services/lead-tracking.ts`

### Replace `buildFollowUpIntent()` (lines 254-283)

**Add import:**
```typescript
import { generateLeadFollowUpIntent } from '@/lib/ai/mila-voice'
```

**Delete** the entire `buildFollowUpIntent()` function (lines 251-283).

**Replace** the call site at line 205:

**Before:**
```typescript
const intent = buildFollowUpIntent(status, cpName, daysSinceActivity, channel, followUpCount, conversation)
```

**After:**
```typescript
const topic = conversation.topic || ''
const intent = await generateLeadFollowUpIntent(
  status,
  cpName,
  daysSinceActivity,
  topic,
  channel,
  followUpCount,
  settings
)
```

Note: `settings` is already available in scope (it's fetched earlier in the function). The `await` is important — this is now async.

Check that the containing function is already `async` (it should be). The return value shape is the same: `{ intentCs, rationaleCs }`.

---

## Step 5: Remove `generateFinalDraft` and `generateBriefHeadline` from gemini.ts

File: `src/lib/ai/gemini.ts`

- **Delete** the `generateFinalDraft()` function entirely (lines 305-356)
- **Delete** the `generateBriefHeadline()` function entirely (lines 389-400)
- **Update** any imports in other files that import these from `gemini.ts` — they should now import from `mila-voice.ts`:
  - `src/services/planning.ts` — `regenerateDraft()` uses `generateFinalDraft`. Update import.
  - `src/services/morning-brief.ts` — uses `generateBriefHeadline`. Update import (already handled in Step 3).

---

## Step 6: Verify

```bash
npm test
npm run build
```

All 28 tests in `mila-voice.test.ts` must pass. All existing tests must still pass. Build must succeed.

If any pinning test fails (`actions.test.ts`, `lead-tracking.test.ts`, `threading.test.ts`, `defaults.test.ts`), STOP and report. Do NOT change the expected values.

---

## File change summary

| File | Action |
|------|--------|
| `src/lib/ai/mila-voice.ts` | **CREATE** — 5 exported functions |
| `src/services/planning.ts` | **EDIT** — delete hardcoded overwrites (lines 234-297), call `generateSchedulingIntent()` |
| `src/services/morning-brief.ts` | **EDIT** — delete hardcoded greeting/subject/urgent, call `generateBriefIntro()` + `generateUrgentIntro()` |
| `src/services/lead-tracking.ts` | **EDIT** — delete `buildFollowUpIntent()`, call `generateLeadFollowUpIntent()` |
| `src/lib/ai/gemini.ts` | **EDIT** — delete `generateFinalDraft()` and `generateBriefHeadline()` |

No other files should be modified except import updates.
