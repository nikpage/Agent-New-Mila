# Refactor Coding Chunks

Master plan: `docs/Refacrot plan.md`

Each chunk is one CLI session. Each is independently testable. Do them in order — later chunks depend on earlier ones.

---

## Chunk 1: Rename gemini.ts → tasks.ts

**Scope**: Pure rename + import path updates. Zero logic changes.

**Files to modify**:
- Rename `src/lib/ai/gemini.ts` → `src/lib/ai/tasks.ts`
- Update every file that imports from `@/lib/ai/gemini` (23+ files — use grep to find all)
- Update `src/lib/ai/context.ts` which imports `parseEnrichedText` from `./gemini`

**Test**: `npm test && npm run build` — must pass with zero diff in behavior.

**One commit, one purpose.**

---

## Chunk 2: Schema + types

**Scope**: TypeScript types + column drops. No service logic.

**DB migration is already applied.** The following tables and FK columns already exist in the database:
- `deals`, `deal_participants`, `entity_map`, `deal_graph_nodes`, `deal_graph_edges`, `extraction_results`
- FK columns: `conversation_threads.deal_id`, `deal_timeline.deal_id`, `deal_timeline.temporal_data`, `deal_timeline.is_emergency`, `action_proposals.deal_id`, `journal_entries.deal_id`

**Remaining work**:
1. Add TypeScript types to `src/lib/supabase/types.ts`: Deal, DealInsert, DealParticipant, EntityMapEntry, DealGraphNode, DealGraphEdge, ExtractionResult + convenience aliases
2. Drop columns (separate migration): `conversation_threads.embedding`, `conversation_threads.priority_score`
3. Drop table: `message_embeddings`

**Test**: `npm run typecheck && npm run build`. Existing tests must still pass (new columns are nullable, dropped columns aren't read).

---

## Chunk 3: DB layer + backfill

**Scope**: CRUD modules for new tables + 1:1 backfill script.

**New files**:
- `src/lib/db/deals.ts` — createDeal, getDealById, getDealsForUser, getActiveDealsForCP, findDealByExternalThread, updateDeal, archiveDeal
- `src/lib/db/entity-map.ts` — upsertEntity, getEntitiesForDeal, getEntity, deleteEntity
- `src/lib/db/deal-graph.ts` — createNode, updateNodeStatus, getNodesForDeal, getBlockingNodes, createEdge, getEdgesForDeal, removeEdge, getDAG
- `src/lib/db/deal-participants.ts` — addParticipant, getParticipantsForDeal, dropParticipant, findDealsForCP

**Backfill script**: `scripts/backfill-deals.ts`
- For each conversation_thread: create a deals row (title=topic, category from CP role/content heuristic, status=active, deal_type from conversation)
- Set conversation_threads.deal_id = new deal id
- Set deal_timeline.deal_id for all entries in that conversation
- Set action_proposals.deal_id for all actions in that conversation
- Copy thread_participants → deal_participants
- **Merge candidates**: After initial 1:1 backfill, run a second pass: group deals by CP. If a CP has multiple deals, flag `potential_merge_with` on those that share similar topics (substring match on title). Log flagged pairs for manual review. Don't auto-merge — the user decides.

**Test**: Run backfill on dev DB. Verify counts match. Verify merge candidates are flagged, not merged. `npm test && npm run build`.

---

## Chunk 4: Temporal DSL

**Scope**: The go/no-go experiment. Build in isolation, test in isolation.

**New files**:
- `src/lib/temporal/dsl.ts` — 10-15 functions: `tomorrow(anchor)`, `nextWeekday(anchor, day)`, `atTime(date, hour, minute)`, `deadlineBefore(date)`, `dateOffset(anchor, {days?, weeks?})`, `thisWeekday(anchor, day)`, `startOfDay(date)`, `endOfDay(date)`, `morning(date)`, `afternoon(date)`, `nextWeek(anchor)`, `specificDate(year, month, day)`
- `src/lib/temporal/executor.ts` — takes generated code string, runs in `vm.runInNewContext()` with only the DSL functions available, 1-second timeout, returns ISO-8601 or throws
- `src/lib/temporal/prompt.ts` — the system prompt documenting the DSL for the LLM
- `src/services/temporal-extractor.ts` — `extractTemporalExpressions(text, messageTimestamp, settings)` — calls LLM with prompt, executes generated code, returns TemporalResult
- `src/lib/temporal/__tests__/dsl.test.ts` — unit tests for each DSL function
- `src/lib/temporal/__tests__/executor.test.ts` — sandbox safety tests (no fs, no network, timeout works)

**Go/no-go test**: `scripts/eval-temporal.ts`
- 50 Czech temporal expressions (hardcoded in the script)
- For each: call the LLM with the DSL prompt, execute the code, check if the output is a valid ISO date
- Report: X/50 valid. Target: >90% (45+). Below 80% → redesign DSL.

**Test**: `npm test` (new tests). The go/no-go script is manual.

---

## Chunk 5: Fact extractor + reconstruction critic

**Scope**: Replace enrichMessage + extractMessageFacts with one unified extractor. Plus quality check.

**New files**:
- `src/services/fact-extractor.ts` — `extractFactsAndBeliefs(dealMessages, resolvedTimestamps, dealContext, settings): Promise<ExtractionOutput>`
- `src/services/reconstruction-critic.ts` — `critiqueExtraction(originalMessages, extraction): Promise<CritiqueResult>`

**AI model config**: Add `extraction` and `reconstruction_critic` stages to `src/config/ai-models.ts`.

**Read first**: `src/lib/ai/tasks.ts` (was gemini.ts) — understand the current enrichMessage and extractMessageFacts prompts. The new extractor merges both into one call with scratchpad-first output.

**Types**: ExtractionOutput, HardFact, SoftObservation, CritiqueResult — defined in refactor plan Phase 1.4 and 1.5.

**Test**: Write tests with sample messages. Compare extraction output to what enrichMessage currently produces. The critic should find zero gaps on a clean extraction.

**Do NOT wire into ingestion.ts yet** — that's Chunk 7.

---

## Chunk 6: World model updaters + deal templates

**Scope**: Deterministic code that writes extraction results to entity map, belief log, and dependency graph. Plus deal-type-specific graph templates.

**New files**:
- `src/services/entity-map-updater.ts` — `updateEntityMap(dealId, hardFacts): Promise<void>` — iterates facts, calls upsertEntity
- `src/services/belief-log-updater.ts` — `updateBeliefLog(dealId, observations): Promise<void>` — appends to journal_entries with scope='deal_id'
- `src/services/graph-updater.ts` — `updateGraph(dealId, hardFacts): Promise<void>` — matches facts to node labels, flips status. One LLM call for genuinely novel edges.
- `src/config/deal-templates.ts` — default DAG templates per deal type. **Templates are starting points, not rigid paths:**
  - Sale: listing → viewings → offer → contract → financing → notary → registration
  - Purchase: search → viewing → offer → inspection → financing → notary → registration
  - Rental: listing → viewing → contract → move-in
  - Personal: single node (the event)
  - Admin: single node (respond/complete)
  - **Every template node has `skippable: true` by default** (except terminal nodes like registration/move-in). The graph updater can mark nodes `skipped` when facts indicate a step was bypassed (e.g. off-market deal skips listing+viewings). Negotiation loops (offer → counter → counter) are handled by the graph updater creating additional offer nodes as facts arrive — the template seeds the first one, subsequent rounds are appended.

**AI model config**: Add `graph_proposal` stage to `ai-models.ts`.

**Test**: Unit tests with sample HardFact/SoftObservation arrays. Verify entity_map upserts, journal appends, graph node status flips. **Include test for skipped nodes and multi-round negotiation (3 offer nodes on one deal).**

---

## Chunk 7a: Deal tagger + bypass filter

**Scope**: Replace threading with deal tagging. Add emergency detection. Do NOT rewire ingestion yet.

**New files**:
- `src/services/deal-tagger.ts` — `tagMessageToDeal(entry, userId): Promise<Deal>`. Algorithm: external thread ID → CP deal count → AI assignment → create new deal
- `src/services/bypass-filter.ts` — `checkBypass(text, channel, settings): Promise<{isEmergency, reason}>`. Cheapest LLM call, sends immediate email if true.

**AI model config**: Add `bypass` stage to `ai-models.ts`.

**Test**: Unit tests for deal tagger (mock DB) and bypass filter (mock AI). `npm test && npm run build`.

**One commit. No ingestion.ts changes yet.**

---

## Chunk 7b: Ingestion rewire

**Scope**: Wire the new pipeline into ingestion.ts and agent.ts.

**Files to modify**:
- `src/services/ingestion.ts` — replace enrichMessage calls with: bypass filter → temporal extractor → fact extractor → critic → entity map update → belief log update → graph update → anomaly detector
- `src/services/agent.ts` — replace threading steps with deal tagger call

**Dual-write rules**: During transition, write to BOTH `messages.enriched_text` AND `entity_map`. Readers:
- `planning.ts`, `lead-tracking.ts`, `morning-brief.ts` → continue reading `messages.enriched_text` (old path, unchanged until Chunk 10)
- New graph walker (Chunk 8) → reads from `entity_map` only
- `analyzeConversation` → reads `messages.enriched_text` (unchanged)

Dual-write ends at Chunk 10 cutover. Do not remove enriched_text writes before then.

**Test**: `npm test && npm run build`. Run against test emails. Verify deals are created, entities are written, bypass fires on emergency text. Verify old pipeline still works (planning/lead-tracking unaffected).

---

## Chunk 8a: Graph walker

**Scope**: Deterministic graph traversal. No scoring, no anomaly detection.

**New files**:
- `src/services/graph-walker.ts` — `walkAllDeals(userId): Promise<GraphWalkerOutput[]>`. Loads DAGs, walks against time/calendar/travel. Detects blocking tasks, due-soon, overdue, stale leads.

**Test**: Build sample DAGs in tests, verify walker output for each taskType (blocking, due_soon, overdue, has_slack, lead_cooling, lead_cold, lead_dead). Include test with skipped nodes (should be ignored). `npm test && npm run build`.

---

## Chunk 8b: Scoring engine + anomaly detector

**Scope**: Score walker output. Add anomaly detection.

**New files**:
- `src/services/scoring-engine.ts` — `scoreWalkerOutput(tasks, settings): ScoredTask[]`. Full formula from refactor plan: `dealImportance + timePressure + graphPressure + immovability + anomalyBoost`.
- `src/services/anomaly-detector.ts` — `detectAnomaly(text, dealContext, settings): Promise<AnomalyResult>`. One cheap LLM call per message.

**AI model config**: Add `anomaly` stage to `ai-models.ts`.

**Test**: Verify scoring ranks a 50M low-urgency deal above a 2M medium-urgency deal. Verify graphPressure terms (blockingFanout, criticalPath) affect ranking. `npm test && npm run build`.

---

## Chunk 8c: Parallel comparison

**Scope**: Run new pipeline alongside old pipeline, compare output. **This is the go/no-go gate for Chunk 10.**

**New file**: `scripts/compare-pipelines.ts`
- For a test user: run existing planning.ts + lead-tracking.ts → collect actions
- Run graph walker + scoring engine → collect scored tasks
- Output comparison report:
  - Actions present in old but missing in new (REGRESSION)
  - Actions present in new but missing in old (NEW SIGNAL)
  - Urgency/priority ranking differences
  - Lead status differences

**Pass criteria** (all must be met):
1. Zero regressions on urgency >= 7 actions (new pipeline catches everything the old one catches for high-urgency)
2. Lead tracking coverage: new pipeline detects >= 90% of cooling/cold/dead leads that old pipeline detects
3. Priority ranking: top-5 actions by score have >= 80% overlap between old and new

**If criteria not met**: File issues, fix graph walker/scoring, re-run. Do NOT proceed to Chunk 9 until pass criteria are met.

**Test**: Manual run on test user. Results reviewed by human.

---

## Chunk 9a: Card generator

**Scope**: Generate action cards from scored tasks. No orchestration changes.

**New files**:
- `src/services/card-generator.ts` — `generateCards(scoredTasks, settings): Promise<ActionCard[]>`. One LLM call per card. Pulls beliefs for tone. Adds placeholders for unknowns.

**Test**: Unit tests with mock scored tasks. Verify card types (REPLY/SCHEDULE/TODO) are correctly derived from node_type + taskType. `npm test && npm run build`.

---

## Chunk 9b: Orchestration split (Flow A / Flow B)

**Scope**: Rewrite agent.ts into two flows. New planner endpoint.

**New files**:
- `src/app/api/planner/run/route.ts` — new endpoint for Flow B (batch planner)

**Files to modify**:
- `src/services/agent.ts` — split into Flow A (ingestion + world model, triggered by dispatcher) and Flow B (graph walker + scoring + cards + scheduling + brief, triggered at 8:00/13:00)
- `src/services/morning-brief.ts` — change from conversation-grouped to deal-grouped action ordering

**Test**: `npm test && npm run build`. Run full pipeline end-to-end on test user. Verify briefs generate correctly.

---

## Chunk 10: Cutover + cleanup

**Prerequisite**: Chunk 8c pass criteria must be met. Do NOT proceed otherwise.

**Scope**: Remove old code. Drop deprecated columns. Final validation.

**Rollback safety**: Before any deletions, create a git tag `pre-cutover-baseline` on the current commit. If production briefs degrade after cutover, revert to this tag immediately. The tag preserves planning.ts, lead-tracking.ts, and all deleted functions in a known-good state.

**Delete**:
- `src/services/planning.ts`
- `src/services/lead-tracking.ts`
- `src/shared/scoring.ts` → `computeDaysIgnored` (keep `selectOfferMultiplier`)
- Functions from `src/lib/ai/tasks.ts`: `enrichMessage`, `extractMessageFacts`, `triageConversation`, `verifyTriage`
- Embedding generation calls in ingestion.ts
- `src/lib/db/embeddings.ts` (if no other consumers)
- Dual-write to `messages.enriched_text` in ingestion.ts (stop writing, entity_map is now the sole source)

**Gut**: `src/services/threading.ts` — remove `assignToConversation`, `processTimelineEntries`. Keep `rebuildConversationSummary` and legacy path for bulk ingestion.

**Drop columns** (migration): `messages.enriched_text`, `conversation_threads.messages_since_rebuild`.

**Update tests**: Remove/update tests that reference deleted functions. Update pinning tests if behavior intentionally changed (report to user first per CLAUDE.md rules).

**Test**: `npm test && npm run build`. Full regression check. Run on test user, compare brief output to pre-cutover-baseline tag output.

**Post-deploy monitoring**: Watch Sentry for 48 hours. If brief quality degrades or error rate spikes, revert to `pre-cutover-baseline` tag and investigate.

---

## How to use this with CLI

For each chunk, start a fresh CLI session and say:

```
Read docs/Refacrot plan.md and docs/REFACTOR-CHUNKS.md.
Implement Chunk N. Read all files listed in that chunk before writing any code.
```

The CLI session will read the master plan for context and the chunk for specific instructions.

**Total chunks**: 13 (1, 2, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 8c, 9a, 9b, 10). Gates: Chunk 4 (temporal DSL go/no-go at 90%), Chunk 8c (pipeline comparison pass/fail), Chunk 10 (pre-cutover tag before deletions).
