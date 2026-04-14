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

**Scope**: New tables, new FK columns, updated TypeScript types. No service logic.

**New tables** (write migration SQL + add to `src/lib/supabase/types.ts`):
- `deals` — see "Updated deals table (final)" in refactor plan
- `deal_participants` — see "New table: deal_participants" in refactor plan
- `entity_map` — see Phase 2.1 in refactor plan
- `deal_graph_nodes` — see Phase 2.3 in refactor plan
- `deal_graph_edges` — see Phase 2.3 in refactor plan
- `extraction_results` — id, user_id, deal_id, scratchpad, hard_facts (jsonb), soft_observations (jsonb), created_at

**New FK columns on existing tables**:
- `conversation_threads.deal_id` (uuid FK → deals, nullable)
- `deal_timeline.deal_id` (uuid FK → deals, nullable)
- `action_proposals.deal_id` (uuid FK → deals, nullable)
- `journal_entries.deal_id` (uuid FK → deals, nullable)
- `deal_timeline.temporal_data` (jsonb, nullable)
- `deal_timeline.is_emergency` (boolean, default false)
- `deal_graph_nodes.cp_id` (uuid FK → cps, nullable — for buyer-specific branches)

**Columns to drop** (can be separate migration):
- `conversation_threads.embedding`
- `conversation_threads.priority_score`

**Table to drop**:
- `message_embeddings`

**Types to add** in `src/lib/supabase/types.ts`: Deal, DealInsert, DealParticipant, EntityMapEntry, DealGraphNode, DealGraphEdge, ExtractionResult + convenience aliases.

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
- For each conversation_thread: create a deals row (title=topic, category='business', status=active, deal_type from conversation)
- Set conversation_threads.deal_id = new deal id
- Set deal_timeline.deal_id for all entries in that conversation
- Set action_proposals.deal_id for all actions in that conversation
- Copy thread_participants → deal_participants

**Test**: Run backfill on dev DB. Verify counts match. `npm test && npm run build`.

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
- `src/config/deal-templates.ts` — default DAG templates per deal type:
  - Sale: listing → viewings → offer → contract → financing → notary → registration
  - Purchase: search → viewing → offer → inspection → financing → notary → registration
  - Rental: listing → viewing → contract → move-in
  - Personal: single node (the event)
  - Admin: single node (respond/complete)

**AI model config**: Add `graph_proposal` stage to `ai-models.ts`.

**Test**: Unit tests with sample HardFact/SoftObservation arrays. Verify entity_map upserts, journal appends, graph node status flips.

---

## Chunk 7: Deal tagger + bypass filter + ingestion rewire

**Scope**: Replace threading with deal tagging. Add emergency detection. Wire new pipeline into ingestion.ts.

**New files**:
- `src/services/deal-tagger.ts` — `tagMessageToDeal(entry, userId): Promise<Deal>`. Algorithm: external thread ID → CP deal count → AI assignment → create new deal
- `src/services/bypass-filter.ts` — `checkBypass(text, channel, settings): Promise<{isEmergency, reason}>`. Cheapest LLM call, sends immediate email if true.

**Files to modify**:
- `src/services/ingestion.ts` — replace enrichMessage calls with: bypass filter → temporal extractor → fact extractor → critic → entity map update → belief log update → graph update → anomaly detector
- `src/services/agent.ts` — replace threading steps with deal tagger call

**AI model config**: Add `bypass` stage to `ai-models.ts`.

**Critical**: Dual-write period. Keep writing to messages.enriched_text AND entity_map until Chunk 10 cutover.

**Test**: `npm test && npm run build`. Run against test emails. Verify deals are created, entities are written, bypass fires on emergency text.

---

## Chunk 8: Graph walker + scoring engine

**Scope**: Replace planning.ts + lead-tracking.ts with deterministic graph traversal + multiplicative scoring.

**New files**:
- `src/services/graph-walker.ts` — `walkAllDeals(userId): Promise<GraphWalkerOutput[]>`. Loads DAGs, walks against time/calendar/travel. Detects blocking tasks, due-soon, overdue, stale leads.
- `src/services/scoring-engine.ts` — `scoreWalkerOutput(tasks, settings): ScoredTask[]`. Multiplicative formula from refactor plan: `withinDealRank × dealValueMultiplier × personalFlagBoost`.
- `src/services/anomaly-detector.ts` — `detectAnomaly(text, dealContext, settings): Promise<AnomalyResult>`. One cheap LLM call per message.

**AI model config**: Add `anomaly` stage to `ai-models.ts`.

**Test**: Build sample DAGs in tests, verify walker output. Verify scoring ranks a 50M low-urgency deal above a 2M medium-urgency deal. Run in parallel with existing planning for comparison (don't replace yet).

---

## Chunk 9: Card generator + orchestration

**Scope**: Generate action cards from scored tasks. Rewrite agent.ts into Flow A / Flow B.

**New files**:
- `src/services/card-generator.ts` — `generateCards(scoredTasks, settings): Promise<ActionCard[]>`. One LLM call per card. Pulls beliefs for tone. Adds placeholders for unknowns.
- `src/app/api/planner/run/route.ts` — new endpoint for Flow B (batch planner)

**Files to modify**:
- `src/services/agent.ts` — split into Flow A (ingestion + world model, triggered by dispatcher) and Flow B (graph walker + scoring + cards + scheduling + brief, triggered at 8:00/13:00)
- `src/services/morning-brief.ts` — change from conversation-grouped to deal-grouped action ordering

**Test**: `npm test && npm run build`. Run full pipeline end-to-end on test user. Verify briefs generate correctly.

---

## Chunk 10: Cutover + cleanup

**Scope**: Remove old code. Drop deprecated columns. Final validation.

**Delete**:
- `src/services/planning.ts`
- `src/services/lead-tracking.ts`
- `src/shared/scoring.ts` → `computeDaysIgnored` (keep `selectOfferMultiplier`)
- Functions from `src/lib/ai/tasks.ts`: `enrichMessage`, `extractMessageFacts`, `triageConversation`, `verifyTriage`
- Embedding generation calls in ingestion.ts
- `src/lib/db/embeddings.ts` (if no other consumers)

**Gut**: `src/services/threading.ts` — remove `assignToConversation`, `processTimelineEntries`. Keep `rebuildConversationSummary` and legacy path for bulk ingestion.

**Drop columns**: `messages.enriched_text` (was kept during transition), `conversation_threads.messages_since_rebuild`.

**Update tests**: Remove/update tests that reference deleted functions. Update pinning tests if behavior intentionally changed (report to user first per CLAUDE.md rules).

**Test**: `npm test && npm run build`. Full regression check. Run on test user, compare brief output to pre-refactor baseline.

---

## How to use this with CLI

For each chunk, start a fresh CLI session and say:

```
Read docs/Refacrot plan.md and docs/REFACTOR-CHUNKS.md.
Implement Chunk N. Read all files listed in that chunk before writing any code.
```

The CLI session will read the master plan for context and the chunk for specific instructions.
