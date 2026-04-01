# UX Refactor Spec

## Core Principle
Mila is a sharp assistant briefing her boss. Not a dashboard. Not a database. She talks like a person.

User ALWAYS reviews before anything goes out in his name. No autonomous sending. Ever.

## Architecture: Email + Web

### Email = Notification + Preview
- Scannable headline stories. No interaction needed — some days the email is enough.
- Each action = mini news story: **headline + 2-3 sentences**.
- Mila's voice — direct, natural, urgent when needed. Not keyword telegrams.
- No badges, no labels. Action type woven into the text.
- Urgency conveyed through words ("before you drive to the office"), not color coding.
- Each headline tappable → opens web brief page focused/scrolled to that card.
- One "Open in Mila" link at top for full web experience.
- Calendar section: confirmed events + holds ("čeká na potvrzení") distinguished.
- Completed items section (what Mila already handled).
- Email HTML is static — no JS, no state changes, no AMP.

**Example headlines:**

> **Novotný POTŘEBUJE odpověď do poledne**
> Přijdete o deal za 4.5M pokud neodpovíte dnes. Vyřiďte to než dojedete do kanceláře. Schůzku na zítra v 9 jsem naplánovala.

> **Zavolejte Evě do 10**
> Je připravená dát vám podmínky a chce podepsat tento týden. Hovor je zarezervovaný na 9:40.

### Web = Full Interactive Workspace
- Mobile-first. The real workspace where actions happen.
- Pre-built at brief send time for instant load. Hydrates with fresh data on open (covers new items between send and open).
- Live state persists in DB — done stays done on re-open.
- Cards in a vertical feed, scrollable.

## Web Card Structure

### Collapsed (default)
Same headline story from email. Tappable to expand. Shows live status (done/sent/pending).

### Expanded — Common Elements
1. **Deal narrative** — where the deal stands, how it got here, key facts (from summary_json).
2. **Type-specific content** (see below).
3. **Last CP message** — what triggered this action.
4. **CTAs** — type-specific, bottom-fixed on mobile.
5. **Future: voice notes input** — mobile-primary, collapsed on desktop. Backend not built yet, leave space in layout.

Done cards collapse with a checkmark.

## Type-Specific Cards

### REPLY
**Expanded content:**
1. **Mila's questions form** (if CP asked questions requiring user input):
   - Form IS the primary content, not hidden. First thing user sees.
   - Smart inputs: year → year picker, yes/no → two buttons, known options → tappable chips + "jinak" text field, unknown → text field.
   - Mila pre-fills what she can from deal context. User confirms or corrects.
   - "Zjistím" button per question → creates a linked TODO if user can't answer now.
   - If no questions: form doesn't appear at all.
2. **Mila's draft** — visible below questions. Updates as answers come in. Editable inline (tap to edit text directly).
3. **Instruction field** ("Chceš něco změnit?") — free text for bigger mods. "Připomeň bazén pro děti" → tap Přepsat → Haiku regenerates draft incorporating instruction.

**Draft pipeline:** Sonnet writes rough draft (planning) → Haiku refines with user answers + grammar (draft_edit).

**CTAs:** **Odeslat** / **Úkol**
- Odeslat = send what's on screen.
- Úkol = convert to TODO, Mila tracks it. If user sends the email himself via Gmail, Mila catches on next ingest and clears automatically.

### SCHEDULE
**Expanded content:**
1. **Mila's story** (same headline text from collapsed view, stays visible).
2. **Meeting type chips**: Osobně / Online / Telefon.
3. **Duration chips**: 10 / 30 / 60 / custom.
4. **Location field** (Osobně only) — triggers travel buffer calculation in backend, invisible to user.
5. **Pevný / Flexibilní toggle** — sets weight to 10 (Pevný) or 1 (Flexibilní). Existing conflict resolution logic uses this.
6. **Draft message to CP** (editable inline, same pattern as REPLY).
7. **Instruction field** (same as REPLY — free text for mods).

**CTAs:** **Potvrdit** / **Úkol**
- Potvrdit = send invite as shown.
- Úkol = convert to TODO, Mila tracks it.
- No "Změnit" button — all fields are editable inline. User changes what they want, taps Potvrdit.

**Shares base elements with conflict card** — conflict adds extras on top, not a completely different layout.

### TODO
**Expanded content:**
1. **Mila's story** (context — why this task exists).
2. **Task description** — what needs doing.
3. **Due date/time** — explicit. This is where urgency + days ignored come in.
4. **Due context** — natural language: "Potřebuješ to před schůzkou s Novotným ve čtvrtek."
5. **Linked question** — if this TODO was created via "Zjistím" on a REPLY question, shows the original question. Completing it returns user to the parent REPLY card with the answer filled in.

**CTAs:**
- **Hotovo** — done, remove. If linked to a parent REPLY/SCHEDULE, that card surfaces in next brief.
- **Odložit** — segmented control: Dnes / Zítra / Příští týden. Resets due date/time.
- **Smazat** — small, less prominent. Kills it entirely.

No draft. No instruction field. TODOs are for the user, not for Mila to send.

Note: postponing and completing are separate actions. Don't merge them.

### CONFLICT (extends SCHEDULE)
- Rare — only when high-urgency action's time is already booked and Mila couldn't find an alternative.
- Same base as SCHEDULE card.
- Adds conflict info in plain language: "Koliduje s: Zubař 14:00. Přesunout zubaře na 16:00?"
- No scores, no weights, no technical jargon.
- Extra CTAs: "Přesunout [event name]" / "Nechat obojí"

## Day Itinerary (Web Brief Page)

### Layout
- Simple linear list. Each day = section header, events listed chronologically.
- Shows today + tomorrow + however many days have events. Scrollable.
- Changes sync to Google Calendar via existing API.

### Event Row
- Time · Title · Location
- Tap → edit time, location
- Swipe → delete/cancel
- Holds visually distinct ("čeká na potvrzení")

### Travel Buffers
- NOT shown as separate rows. Shown as subtle annotation on the meeting: "15 min cesta" above the event.
- When meeting moves, backend recalculates buffer automatically. User doesn't manage buffers.

### Drag to Reschedule
User can drag events to new times. Any move triggers Mila's consequence review.

**Flow:**
1. User drags event to new time.
2. Backend recalculates travel buffers, detects affected events/invitees.
3. Mila generates a conversational rundown of consequences — one AI call with full context:
   - CP relationship history (how many times rescheduled, deal status, sentiment)
   - Impact on other events (buffer conflicts, cascading moves)
   - Mila's honest opinion — she pushes back when warranted
4. Example: "Novotného jsi přesunul už 3x tento týden. Další zpoždění nepůsobí dobře. Eva je s termínem spokojená a deal za 4.5M běží hladce. Stojí to za to?"
5. User reads, decides:
   - **Potvrdit změny** → each affected CP gets a card in the SCHEDULE notification flow. User reviews and sends each.
   - **Zpět** → undo drag, original state restored.

**AI inputs for consequence rundown:**
- Rescheduled CP: name, deal value, deal status, reschedule history (count from action_proposals)
- Affected CPs: same context for anyone whose slot shifts
- summary_json for each conversation — sentiment, current state
- Calendar context — what's around the new slot

**Key rules:**
- Every time change affecting an invitee requires user to review a notification to CP. No silent calendar updates. Mila drafts a polite, context-aware message. Being rude with people's time is unacceptable.
- Google Calendar sync happens AFTER user confirms and sends notifications.
- "Zpět" always available. No change committed until user confirms.
- Mila uses judgment — she has the relationship data and isn't afraid to say "this is a bad idea."

## Web Brief Page — Full Layout

### Mobile-First, Single Scrollable Feed
No tabs, no navigation, no sidebar. One vertical feed. Same page serves both regular briefs and urgent notifications (just fewer cards for urgent).

### Page Sections (top to bottom)

1. **Mila's greeting** — one line, same as email. Sets the tone.

2. **Action cards feed** — collapsed by default, sorted by urgency. Tap to expand. When one card is open, others stay collapsed below. Closing returns to feed view.

3. **Day itinerary** — today + tomorrow + upcoming days with events. Linear list, draggable (see Day Itinerary section).

4. **Completed items** — collapsed by default. "Mila vyřídila 3 věci" — tappable to expand. Low priority, bottom of page.

### Sticky Bottom Bar
Always visible. Context-shifts based on state:

- **Card expanded** → shows that card's CTAs (Odeslat/Úkol, Potvrdit/Úkol, Hotovo/Odložit/Smazat depending on type).
- **No card expanded** → system actions: settings, refresh, future chat trigger.

Keeps the thumb zone always useful. No dead space on mobile.

### Loading Strategy
- Pre-built at brief send time (SSG/ISR) for instant first paint.
- Hydrates with fresh data on client open — covers new items between brief send and page open.
- Live state persists in DB — done/sent status reflected on re-open.

### Urgent Notifications
Same page, same URL, same layout. Just filtered to urgent cards only. No separate design or routing.

### Routing
- Single URL per user: `/brief/{userId}` (authenticated)
- Email deep-links to specific card: `/brief/{userId}#action-{actionId}`
- Opening via deep-link: that card expanded, rest collapsed below.
- No separate URLs per brief. The page is a **live brief** — always reflects Mila's current state, not a snapshot from when the email was sent.

### Live Brief Concept
The page is always alive. Not an inbox to empty — a command center.
- New actions appear as Mila processes them.
- Itinerary is always visible.
- Completed items show what was handled.
- User can open the page anytime, not just after a brief email.

### Dismissed Items / History
- Dismissing a card clears it from the feed. No data deleted — emails/messages still exist in Gmail/WhatsApp.
- Small "Historie" link (settings area or bottom of page). Not prominent. Just a safety net for mistakes.
- History shows dismissed/completed actions. User can restore a dismissed card back to pending.

## AI Generation

### Brief Headlines
New function in `mila-voice.ts`: generates headline + 2-3 sentence story per action.

**Inputs:**
- CP name, deal value, action type
- summary_json.currentState (deal context)
- intent (what Mila proposes)
- days since CP contact
- urgency + urgency justification
- today's calendar (so Mila can reference "before your 2pm")
- what Mila already set up (holds, scheduled calls)

**Output:** headline + 2-3 sentence story. Natural text, not structured fields.

**Prompt direction:** "You are Mila. Brief your boss like a sharp assistant. Be direct. Urgency comes through words, not labels. Reference his schedule. Tell him what you already handled."

### Smart Question Extraction
AI extracts actual CP questions from conversation (not generic "missing field" labels). Maps each to an input type (year, yes/no, options, free text). Pre-fills from deal context where possible.

## Open Items
- [x] SCHEDULE card CTAs — Potvrdit / Úkol
- [x] TODO card CTAs — Hotovo / Odložit / Smazat
- [x] Web page routing / URL structure — live brief at /brief/{userId}
- [ ] Swipe gestures (dismiss, etc.)
- [ ] Voice notes UI placement (future)
- [ ] Native Czech CTA labels — user test needed
- [ ] Urgency visual signal for web cards (words-only? subtle indicator?)
