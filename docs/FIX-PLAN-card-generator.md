# Fix Plan — card-generator missing context

**Related issues:** #36 (urgency stuck at 7), #39 (missing_info hallucinated)

**Root cause (both issues):** `src/services/card-generator.ts` generates REPLY cards without the CP's latest inbound message. It only sees `entityMapSnapshot` + beliefs + task metadata. Downstream effects:

1. **#36:** Walker never emits `inbound_reply` (the type is declared at `graph-walker.ts:29` and mapped to urgency 8 at `card-generator.ts:72`, but `classifyNodes`/`classifyLeadStatus` never produce it). Any active unblocked node without a per-node deadline lands in `blocking` (walker line 162) → `card-generator.ts:73` hardcoded urgency 7. Explains the "all 7" symptom.
2. **#39:** Card-generator's LLM is asked to produce `placeholders` with `{{ ... }}` markers for a `draft_skeleton`, but has no CP message to ground them against. Placeholders/missing_info are hallucinated from entity-map gaps.

Three phases. Each is an independent commit with its own verification.

---

## Phase 1 — Emit `inbound_reply` from walker

**Goal:** walker produces `inbound_reply` WalkerTasks when a deal has a fresh unanswered inbound message. No contract change — type already exists in the union.

**Files:**
- `src/services/graph-walker.ts` — add `classifyInboundReply(deal, now, settings)` alongside `classifyNodes` and `classifyLeadStatus`.
- Uses `getLatestInboundFromCP(cpId)` (`src/lib/db/timeline.ts:122`) and `hasPendingActionForCP(userId, cpId)` (`src/lib/db/actions.ts:475`).

**Logic:**
```
for each deal:
  resolve primary cp_id (TODO during implementation: confirm via Deal.cp_id vs deal_participants)
  if no cp_id → skip
  latest = getLatestInboundFromCP(cp_id)
  if latest is null or latest.occurred_at < last outbound from user → skip
  if hasPendingActionForCP(user_id, cp_id) → skip
  emit WalkerTask { taskType: 'inbound_reply', cpId, nodeId: `deal:${deal.id}:reply`, ... }
```

**Open question (resolve during implementation):** Deal ↔ CP relationship. Check `src/lib/supabase/types.ts` for `Deal.cp_id` or `deal_participants` join. Pick the path that matches how lead-tracking does it today.

**Tests:**
- `npm run typecheck` + `npm run build` pass.
- `npm test` baseline holds (11 failing, 606 passing).
- Add targeted test in `graph-walker.test.ts` if one exists: deal with fresh inbound + no pending REPLY → emits `inbound_reply` task. Deal with pending REPLY → no emission. Deal where latest is outbound → no emission.

**Rollback:** Revert `graph-walker.ts`. No callers changed.

**What this alone delivers:** Visible `inbound_reply` tasks appear in the pipeline. Urgency = 8 (per existing card-generator map). Missing_info still hallucinated (Phase 3). But urgency variance is real now for new-message deals: 8 for fresh inbound vs 7 for pending graph work.

---

## Phase 2 — Thread CP message + enrichment signal into card-generator

**Goal:** `inbound_reply` tasks carry `latestInboundText` and `enrichmentSignal` so card-generator can derive urgency dynamically and (in Phase 3) ground placeholders.

**Files:**
- `src/services/graph-walker.ts` — extend `WalkerTask` (or a subtype for `inbound_reply`) with two optional fields: `latestInboundText?: string`, `enrichmentSignal?: 'HARD DEADLINE' | 'SOFT REFERENCE' | null`.
- `src/services/graph-walker.ts` — in `classifyInboundReply`, parse the message's `enriched_text` via `parseEnrichedText` (from `src/lib/ai/tasks.ts:34`) to extract urgency signal.
- `src/services/card-generator.ts:67-81` — `deriveUrgency(task, hoursUntilDue)` takes the task so it can read `enrichmentSignal`. For `inbound_reply`: base 8, `HARD DEADLINE` → 9, `SOFT REFERENCE` → 8 (no bump), same-day detection bumps to 10 (mirror `planning.ts:44-62` `mapUrgencyToNumber` logic).
- `src/services/scoring-engine.ts` — carry through the new fields in `ScoredTask` (if needed for card-generator — check).

**Prerequisite:** Phase 1 merged.

**Tests:**
- Typecheck + build.
- `card-generator.test.ts` — urgency tests should still pass; add cases for `inbound_reply` with/without HARD DEADLINE.
- Cassette: if a replay cassette depends on exact urgency values, expect diffs. Coordinate cassette re-record after this phase (mentioned in post-compaction queue).

**Rollback:** Revert both files. Phase 1 still works.

**What this alone delivers:** #36 resolved — urgency varies across cards per enrichment context. Missing_info still unrelated to CP questions (Phase 3).

---

## Phase 3 — Ground `missing_info` in CP's message

**Goal:** card-generator's REPLY prompt reads the CP's message and produces `placeholders` only for CP questions it cannot answer from `entityMapSnapshot`.

**Files:**
- `src/services/card-generator.ts:117-175` — `buildCardPrompt`: for `inbound_reply` tasks, append a section with `latestInboundText` + explicit rules:
  - "Identify questions CP literally asked in the message."
  - "For each, attempt to answer from entity map facts."
  - "Questions you cannot answer → add to `placeholders` and use `{{ placeholder }}` in `draft_skeleton`."
  - "NEVER invent questions the CP didn't ask. NEVER add verification questions. NEVER restate CP deadlines as questions."
- `src/services/card-generator.ts:419-421` — no change needed (`placeholders` already drive `missing_info`).

**Prerequisite:** Phase 2 merged (message text flows into generator).

**Tests:**
- Typecheck + build.
- `card-generator.test.ts` — new tests: CP asks question answered by entity map → empty placeholders. CP asks question NOT in entity map → placeholder appears with the question text. No CP question → empty placeholders.
- Manual: trigger a real deal, check `action_proposals.missing_info` reflects only real CP questions.

**Rollback:** Revert prompt change.

**What this delivers:** #39 resolved. missing_info is grounded; hallucinated placeholders gone.

---

## Ordering + checkpoints

Do phases in order. After each:

1. `npm run typecheck && npm run build && npm test` — baseline must hold.
2. Commit with a message linking the phase and issue number.
3. Close the corresponding issue (#36 at Phase 2, #39 at Phase 3).

Do NOT skip phases. Phase 2 depends on Phase 1 emitting tasks. Phase 3 depends on Phase 2 threading message text.

---

## Out of scope

- Triage AI call for urgency classification. Phase 2's deterministic enrichment-based derivation is sufficient and avoids the cost of an LLM call per card.
- Changing `blocking`/`has_slack` hardcoded urgencies. These are not the reported bug; leave alone unless a separate issue surfaces.
- Deleting deprecated `planning.ts`. Still live for `/api/ingest`. Separate future cleanup.

---

## Verification that this plan addresses the flagged symptoms

- User saw urgency=7 on all cards → was `blocking` catch-all. Phase 1+2 add `inbound_reply` with urgency 8/9/10 based on message, so new-inbound deals diverge from pending-work deals.
- User saw hallucinated questions in missing_info → Phase 3 grounds them in CP's actual message text.
- Cassette re-record should happen AFTER all three phases land so the replay captures the new urgency distribution and missing_info shapes.
