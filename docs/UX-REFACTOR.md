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
**CTAs discussed (not final):**
- Hotovo (done)
- Odložit → when picker (today/tomorrow/next week)
- Smazat (kill it)

Note: postponing and completing are separate actions. Don't merge them.

### CONFLICT (extends SCHEDULE)
- Rare — only when high-urgency action's time is already booked and Mila couldn't find an alternative.
- Same base as SCHEDULE card.
- Adds conflict info in plain language: "Koliduje s: Zubař 14:00. Přesunout zubaře na 16:00?"
- No scores, no weights, no technical jargon.
- Extra CTAs: "Přesunout [event name]" / "Nechat obojí"

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
- [ ] TODO card CTAs (finalize)
- [ ] Web page routing / URL structure
- [ ] Swipe gestures (dismiss, etc.)
- [ ] Voice notes UI placement (future)
- [ ] Native Czech CTA labels — user test needed
- [ ] Urgency visual signal for web cards (words-only? subtle indicator?)
