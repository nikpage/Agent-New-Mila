# UX Refactor — Implementation Plan

## Reference
Design spec: `docs/UX-REFACTOR.md`

## Phasing Strategy
Build new system alongside old system. Zero risk to current functionality until the switch in Phase 2. Each phase is independently deployable and revertable.

## Phase 1: New Components (zero changes to existing files except one additive function)

### 1.1 New Route: `/app/brief/[userId]/page.tsx`
- Server component that pre-fetches user data, pending actions, events, completed items.
- Client component for interactivity (card expand/collapse, CTAs, swipe, drag).
- URL: `/brief/{userId}` — email deep-links via `#action-{actionId}`.
- Auth: action token in URL params (same pattern as current `/action/[id]`).
- Pre-render strategy: fetch all data server-side, pass as props. Client hydrates and can refresh for newer data.

### 1.2 New Components: `/components/brief/`

**`BriefFeed.tsx`** — Main feed container
- Renders greeting, action cards, itinerary, completed items.
- Manages which card is expanded (only one at a time).
- Handles scroll-to-anchor for deep links (`#action-{id}`).

**`BriefCard.tsx`** — Collapsed/expanded card wrapper
- Collapsed: headline story + urgency signal (🔥 / 🔥🔥🔥) + live status badge.
- Expanded: renders type-specific inner content.
- Tap to expand/collapse.
- Swipe right = primary action, swipe left = dismiss (Phase 3 polish).

**`ReplyCard.tsx`** — REPLY expanded content
- Question form (if CP asked questions): smart inputs per type (year picker, yes/no buttons, chips + text, free text). "Zjistím" button per question → creates linked TODO.
- Mila's draft: visible below questions, editable inline. Updates as answers come in.
- Instruction field: free text for bigger mods → Haiku regenerates draft.
- CTAs: Odeslat / Úkol.

**`ScheduleCard.tsx`** — SCHEDULE expanded content
- Mila's story (headline text stays visible).
- Meeting type chips: Osobně / Online / Telefon.
- Duration chips: 10 / 30 / 60 / custom.
- Location field (Osobně only). Triggers travel buffer in backend — invisible to user.
- Pevný / Flexibilní toggle (sets weight to 10 or 1).
- Draft message to CP (editable inline).
- Instruction field.
- CTAs: Potvrdit / Úkol.

**`ConflictSection.tsx`** — Extends ScheduleCard
- Plain language: "Koliduje s: [event name] [time]. Přesunout na [alt time]?"
- No scores, no weights, no jargon.
- Extra CTAs: "Přesunout [event name]" / "Nechat obojí".

**`TodoCard.tsx`** — TODO expanded content
- Task description + due date/time.
- Due context in natural language.
- Linked question (if created via "Zjistím" from a REPLY).
- CTAs: Hotovo / Odložit (segmented: Dnes / Zítra / Příští týden) / Smazat.

**`ItineraryView.tsx`** — Day itinerary
- Linear list, one section per day (today + tomorrow + upcoming).
- Event row: Time · Title · Location.
- Holds visually distinct ("čeká na potvrzení").
- Travel buffers shown as annotation ("15 min cesta"), not separate rows.
- Tap to edit time/location.
- Drag to reschedule (Phase 3 — triggers Mila consequence review).

**`StickyBar.tsx`** — Bottom bar
- Card expanded → shows that card's CTAs.
- No card expanded → text input for Mila commands + settings button.
- Command input uses existing parser.ts/executor.ts backend.

**`CompletedSection.tsx`** — Completed items
- Collapsed by default: "Mila vyřídila 3 věci".
- Expandable to show completed action summaries.

### 1.3 New AI Function: `generateBriefHeadline()` in `src/lib/ai/mila-voice.ts`
- ADDITIVE ONLY — new exported function, no changes to existing functions.
- Inputs: CP name, deal value, action type, summary_json.currentState, intent, days since CP contact, urgency + justification, today's calendar, Mila's hold events.
- Output: `{ headline: string, story: string }` — headline + 2-3 sentence narrative.
- Uses drafting stage (Claude Sonnet → Gemini fallback).
- Prompt: "You are Mila. Brief your boss like a sharp assistant. Be direct. Urgency through words. Reference his schedule. Tell him what you already handled."

### 1.4 New Email Template: `/components/brief/headline-email-template.ts`
- New file. Does NOT touch `action-card-template.ts`.
- Renders: greeting + headline stories + calendar (confirmed + holds) + completed items.
- Each headline tappable → links to `/brief/{userId}#action-{actionId}`.
- One "Otevřít v Mile" link at top.
- Urgency signals: 🔥 / 🔥🔥🔥 in headline text.
- Static HTML — no JS, no AMP.

### 1.5 New API Endpoints (all additive)
- `POST /api/brief/[userId]/refresh` — returns latest actions + events for client hydration.
- `POST /api/action/[id]/regenerate-draft` — Haiku regenerates draft with user instruction.
- `POST /api/action/[id]/convert-todo` — converts action to TODO (for Úkol CTA).
- `POST /api/action/[id]/postpone` — sets new due date (for Odložit).

### Phase 1 Verification
- Run `npm test && npm run build` after each component.
- Manually test at `/brief/{userId}` with a real user ID.
- Old system still sends old emails. Old action pages still work. Nothing changes for user.

---

## Phase 2: Wire Up (minimal changes to existing files)

### 2.1 Switch Email Template
- In `src/services/morning-brief.ts`: replace `generateBriefEmailHtml()` internals to use new headline template.
- Old template code stays in file, commented or behind a flag, for easy revert.
- Email links now point to `/brief/{userId}`.

### 2.2 Switch Instant Notifications
- Same swap in the instant notification path in `morning-brief.ts`.
- Urgent emails use headline format, link to brief page.

### 2.3 Backward Compatibility
- Old `/action/[id]` routes stay alive. Already-sent emails with old links keep working.
- No old URLs break. Ever.

### Phase 2 Verification
- Send a test brief to real user, verify email renders correctly.
- Verify all email links open the correct card on the brief page.
- Verify old email links still work.
- Run full test suite: `npm test && npm run build`.

---

## Phase 3: Polish + Cleanup

### 3.1 Interactions
- Swipe gestures (right = primary CTA, left = dismiss).
- Drag-to-reschedule on itinerary with Mila consequence review.
- Card expand/collapse animations.
- Pull-to-refresh.

### 3.2 Performance
- Pre-render caching (ISR or on-demand revalidation at brief send time).
- Optimistic UI updates (mark done immediately, sync in background).

### 3.3 Cleanup
- Remove old `ActionCard.tsx`, `EditForm.tsx`, `SuccessOverlay.tsx` (only after confirming no references).
- Remove old `action-card-template.ts` email card renderer.
- Remove or simplify old `/action/[id]/page.tsx` and `/action/[id]/edit/page.tsx`.
- Remove old brief HTML generation functions from `morning-brief.ts`.

### Phase 3 Verification
- Full test suite.
- Mobile device testing (iOS Safari, Android Chrome).
- Test with real brief data across multiple action types.

---

## Safety Checklist
- [ ] Phase 1: ALL new files except `mila-voice.ts` (additive function only)
- [ ] Phase 1: No existing test modified
- [ ] Phase 1: `npm test && npm run build` passes
- [ ] Phase 2: Only `morning-brief.ts` modified (template swap)
- [ ] Phase 2: Old `/action/[id]` routes still functional
- [ ] Phase 2: Revert plan: swap back to old template function
- [ ] Phase 3: Old components removed only after full verification
- [ ] Pinning tests NEVER modified (per CLAUDE.md)

## File Impact Summary

### New Files (Phase 1)
```
src/app/brief/[userId]/page.tsx
src/components/brief/BriefFeed.tsx
src/components/brief/BriefCard.tsx
src/components/brief/ReplyCard.tsx
src/components/brief/ScheduleCard.tsx
src/components/brief/ConflictSection.tsx
src/components/brief/TodoCard.tsx
src/components/brief/ItineraryView.tsx
src/components/brief/StickyBar.tsx
src/components/brief/CompletedSection.tsx
src/components/brief/headline-email-template.ts
src/app/api/brief/[userId]/refresh/route.ts
src/app/api/action/[id]/regenerate-draft/route.ts
src/app/api/action/[id]/convert-todo/route.ts
src/app/api/action/[id]/postpone/route.ts
```

### Modified Files (Phase 1)
```
src/lib/ai/mila-voice.ts  — additive only: new generateBriefHeadline() export
```

### Modified Files (Phase 2)
```
src/services/morning-brief.ts  — template swap in generateBriefEmailHtml()
```

### Removed Files (Phase 3, after verification)
```
src/components/action/ActionCard.tsx
src/components/action/EditForm.tsx
src/components/action/SuccessOverlay.tsx
src/components/action/action-card-template.ts
src/app/action/[id]/page.tsx (simplify or remove)
src/app/action/[id]/edit/page.tsx (simplify or remove)
```
