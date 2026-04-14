Technical Requirements Map — Full Refactor
Foundational Shift: Conversation → Deal
The single biggest structural change: the grouping unit switches from conversation_threads to a new deals table. Today, conversation_threads serves triple duty as:

The threading target (messages/timeline → conversation)
The planning unit (planning.ts processes per conversation)
The brief unit (action_proposals.conversation_id)
Your plan decouples these. A "deal" is the stable grouping unit. Multiple channels, CPs, email threads — all land on one deal.

New table: deals
Column	Type	Notes
id	uuid PK	
user_id	uuid FK	
title	text	Human-readable deal name
status	text	active / archived / stale
deal_type	text	sale/purchase/rental/lease/consultation/other
created_at	timestamptz	
last_activity_at	timestamptz	Updated on every new message
Migration path for conversation_threads
Keep conversation_threads as a sub-unit of deals (one deal has 1+ conversations)
Add deal_id FK to conversation_threads
Add deal_id FK to deal_timeline
Add deal_id FK to action_proposals
Backfill: initial migration sets deal_id = conversation_id (1:1 for existing data)
Phase 1: Ingestion (Background, 24/7)
1.1 — Deal Tagger
What it replaces: threading.ts → assignToConversation() and the entire 4-step algorithm (thread ID → CP count → density → AI).

Current code: Threading assigns timeline entries to conversations. It uses findConversationByExternalThread, getActiveCpConversationIds, getRecentDensityByConversation, and an AI call (runAITask('threading', ...)) to decide which conversation a message belongs to.

New behavior: Every incoming message gets tagged to a deal. The algorithm must:

Check if the message's external thread ID maps to an existing deal (fast path)
Check if the CP has active deals — if exactly one, assign
If multiple deals for this CP, use content matching (AI call: "which deal does this belong to?")
If no match → flag as "untaggable" (likely new deal or personal item)
Technical steps:

New function: tagMessageToDeal(entry: DealTimelineEntry): Promise<Deal> in a new src/services/deal-tagger.ts
New DB function: findDealByExternalThread(userId, threadId) — queries deals via timeline/messages FK chain
New DB function: getActiveDealsForCP(userId, cpId): Promise<Deal[]> — replaces getActiveCpConversationIds
New DB function: createDeal(...) — creates a deal record + optionally a conversation under it
New DB function: flagUntaggable(entryId) — marks a timeline entry as needing human triage
New table column: deal_timeline.deal_id (nullable, written after tagging)
Deprecate: processTimelineEntries() in threading.ts (replaced by deal tagger)
Keep: rebuildConversationSummary() — still needed, but now triggered per deal, not per conversation
AI prompt change: The threading AI prompt currently outputs a conversation UUID or "NEW". Needs to output a deal UUID or "NEW" instead.
1.2 — Bypass Filter
What it replaces: Nothing — this is new. Currently there's no emergency detection path. Urgent items wait for the next brief cycle (up to 5 mins via instant-notify, but only AFTER the full pipeline runs).

Current code that's adjacent: getHighPriorityUnnotifiedActions() in actions.ts polls for urgency >= 9 every 5 minutes. The bypass filter would fire BEFORE any of that.

Technical steps:

New function: checkBypass(messageText: string, channel: string, settings: UserSettings): Promise<{ isEmergency: boolean; reason: string }> in new src/services/bypass-filter.ts
AI stage: Add bypass to src/config/ai-models.ts — cheapest model (flash-lite), shortest prompt possible
New prompt: Single-purpose: "Is the building on fire? Is there an irreversible deadline within hours? Is someone threatening to walk away NOW?" → boolean + one sentence
Integration point: Called immediately after message ingestion in processOneInboundEmail / WhatsApp daemon handler, BEFORE enrichment
Push notification: Need a notification mechanism. Options:
Reuse instant-notify email path but call it synchronously (not via QStash poll)
Add push notification support (FCM/APNs) — requires new infra
Send immediate email via sendEmail() from lib/google/gmail
New DB column or flag: deal_timeline.is_emergency boolean — marks the entry for audit trail
Fallback: If LLM call fails → treat as non-emergency (same fail-open pattern as filterEmail)
1.3 — Temporal Extractor
What it replaces: The proposedTimes extraction currently embedded in enrichMessage() (gemini.ts:139-178). Currently time expressions are extracted as structured JSON fields (relativeRef, specificDate, dayOfWeek, timeOfDay) with limited reliability.

New behavior: Dedicated LLM call that outputs executable SCATE-style code (Python or JS). The code runs against the message timestamp to produce absolute ISO-8601 dates. If execution fails → flag for human review.

Technical steps:

New function: extractTemporalExpressions(text: string, messageTimestamp: Date, settings: UserSettings): Promise<TemporalResult> in new src/services/temporal-extractor.ts
New AI stage: Add temporal to ai-models.ts — needs a model good at code generation (flash or sonnet)
New prompt:
Input: Czech text + message timestamp
Output: executable code that produces ISO-8601 dates
Must handle Czech temporal expressions: "zítra", "příští týden", "do pátku", "15. března", "kolem 9 nebo 10", etc.
Code execution sandbox: Need a safe way to execute generated code. Options:
vm2 or Node.js vm module with timeout (risky — sandbox escape)
Spin up a restricted Function() with no globals
Use Deno subprocess with permissions lockdown
Python subprocess if SCATE compatibility is important
Recommendation: Node.js vm.runInNewContext() with 1-second timeout, no filesystem/network access
New type:
interface TemporalResult {
  expressions: {
    original_text: string       // Czech text as found
    generated_code: string      // Executable code
    resolved_date: string | null // ISO-8601 result (null if execution failed)
    execution_error: string | null
    confidence: number
  }[]
  needs_human_review: boolean   // true if any execution failed
}

New DB column: deal_timeline.temporal_data (jsonb) — stores the resolved temporal expressions per message
Remove from enrichment prompt: Strip the proposedTimes extraction from enrichMessage() — temporal extraction now has its own step
Integration point: Runs after message cleaning, before Fact & Belief Extractor (so resolved timestamps are available as input)
1.4 — Fact & Belief Extractor
What it replaces: enrichMessage() in gemini.ts (lines 113-198) AND extractMessageFacts() (lines 306-411). Currently these are two separate calls doing overlapping work. The new design merges them into one call with strict fact/belief separation.

Current enrichment output (EnrichedMessageData):

parties, subject, messageType, coreIntent, addresses, proposedTimes, meetingType, urgency, dealStage, keyNumbers
New behavior: One LLM call per message batch (all new messages on a deal since last processing). Outputs strict JSON with:

Hard facts: prices, addresses, deadlines, document states, CP commitments
Soft observations: tone changes, relationship signals, deal momentum
Scratchpad-first: LLM must show reasoning before structured output (auditable)
Technical steps:

New function: extractFactsAndBeliefs(dealMessages: DealMessage[], resolvedTimestamps: TemporalResult, dealContext: DealContext, settings: UserSettings): Promise<ExtractionOutput> in new src/services/fact-extractor.ts
New AI stage: Replace enrichment and triage_extract with extraction in ai-models.ts
New types:
interface ExtractionOutput {
  scratchpad: string    // LLM reasoning (stored for audit)
  hard_facts: HardFact[]
  soft_observations: SoftObservation[]
}
interface HardFact {
  type: 'price' | 'address' | 'deadline' | 'document_state' | 'commitment' | 'contact_info' | 'meeting_venue' | 'deal_stage'
  key: string          // e.g. "asking_price", "notary_address"
  value: string        // the fact
  source_message_id: string
  confidence: number
}
interface SoftObservation {
  topic: string
  content: string
  confidence: number
  source_message_id: string
}

Input change: Takes the deal's recent message batch + resolved timestamps from step 1.3 (not a single message)
Prompt structure: Scratchpad section → structured JSON. The prompt must explicitly ask for reasoning before output.
Remove: enrichMessage() from gemini.ts — no longer called. Its callers in ingestion.ts will call the new extractor instead.
Remove: extractMessageFacts() from gemini.ts — absorbed into the new extractor.
Remove: parseEnrichedText(), enrichedTextToString() — replaced by typed facts.
New DB table: extraction_results — stores scratchpad + raw extraction per deal processing run (audit trail)
1.5 — Reconstruction Critic
What it replaces: Nothing — this is new. Currently there's no quality check on extraction.

Technical steps:

New function: critiqueExtraction(originalMessages: string[], extraction: ExtractionOutput): Promise<CritiqueResult> in new src/services/reconstruction-critic.ts
New AI stage: Add reconstruction_critic to ai-models.ts — could use the same model as extraction
New prompt: "What information in the original messages is NOT captured in this extraction?" → list of gaps or empty
New type:
interface CritiqueResult {
  gaps: string[]
  is_complete: boolean
}

Re-run logic: If gaps.length > 0, call extractFactsAndBeliefs() again with gaps highlighted in the prompt. Maximum 1 re-run to prevent infinite loops.
Integration: Runs after Fact & Belief Extractor, before Phase 2 world model update
Phase 2: World Model Update (Deterministic code, no LLM)
2.1 — Entity Map Update
What it replaces: Currently, hard facts are scattered across:

messages.enriched_text (JSON blob per message)
conversation_threads.summary_json (AI-generated summary)
cps.name, cps.role, cps.locations (CP-level facts)
action_proposals.dollar_value, .weight (per-action scoring inputs)
New behavior: Single source of truth for rigid facts per deal. New data overwrites old.

Technical steps:

New table: entity_map
Column	Type	Notes
id	uuid PK	
user_id	uuid FK	
deal_id	uuid FK	
entity_type	text	'price', 'address', 'deadline', 'document', 'contact', 'venue', 'stage', etc.
entity_key	text	Unique within deal+type, e.g. "asking_price", "notary_address"
entity_value	text	The fact value
source_message_id	uuid FK	Which message this came from
confidence	float	
created_at	timestamptz	
updated_at	timestamptz	
UNIQUE		(deal_id, entity_type, entity_key) — upsert semantics
New DB module: src/lib/db/entity-map.ts
upsertEntity(dealId, type, key, value, sourceMessageId, confidence) — insert or overwrite
getEntitiesForDeal(dealId, type?) — read all or by type
getEntity(dealId, type, key) — read specific fact
deleteEntity(dealId, type, key) — for corrections
Deterministic code: src/services/entity-map-updater.ts
updateEntityMap(dealId, hardFacts: HardFact[]): Promise<void> — iterates facts, calls upsertEntity
No LLM — pure CRUD
Migration: Backfill from existing messages.enriched_text — parse JSON, extract hard facts, write to entity_map
2.2 — Belief Log Update
What partially exists: journal_entries table already has:

scope (global/cp_id/conversation_id/temporal)
confirm_count, conflict_count
type (observation/belief/volatile)
weight, recency_score
What changes:

Scope needs deal_id addition (currently only conversation_id)
Beliefs become truly append-only — no overwrite, only new entries
"Current best guess" becomes a computed view, not a stored value
Technical steps:

Add column: journal_entries.deal_id (uuid FK, nullable) — beliefs can be scoped to deals
Add DB view or function: getCurrentBeliefs(dealId) — returns the latest non-stale entry per topic for a deal, ordered by confirm_count desc. This is the "current best guess" view.
New function: updateBeliefLog(dealId, observations: SoftObservation[]): Promise<void> in new src/services/belief-log-updater.ts
For each observation: createJournalEntry() with scope='deal_id', scope_ref=dealId
Never overwrites — always appends
Contradiction detection: if a new observation contradicts an existing belief (same topic, different content), call recordConflict() on the existing entry
Keep: The existing confirmObservation, recordConflict, expireTemporalEntries functions in journal.ts — they're compatible
Monthly meta-inference: Already configured as belief_audit stage in ai-models.ts (claude-opus). The periodic step that looks for patterns in contradictions is already partially implemented. Needs to be hooked into the new belief log.
2.3 — Dependency Graph Update
What it replaces: Nothing — completely new. Currently there's no dependency tracking between deal steps. The system has no concept of "document X must arrive before step Y can proceed."

New behavior: Each deal has a persistent directed acyclic graph (DAG). Nodes are milestones/events. Edges are dependencies. When a fact arrives ("document received"), the corresponding node flips to true and downstream edges are re-evaluated.

Technical steps:

New table: deal_graph_nodes
Column	Type	Notes
id	uuid PK	
deal_id	uuid FK	
user_id	uuid FK	
label	text	Human-readable node name, e.g. "Financing approved"
node_type	text	'milestone', 'document', 'action', 'deadline', 'external'
status	text	'pending', 'completed', 'blocked', 'skipped'
completed_at	timestamptz	null until complete
deadline	timestamptz	null if no deadline
metadata	jsonb	Extra data (e.g. which entity_map entry satisfied this)
created_at	timestamptz	
New table: deal_graph_edges
Column	Type	Notes
id	uuid PK	
deal_id	uuid FK	
from_node_id	uuid FK	
to_node_id	uuid FK	
edge_type	text	'depends_on', 'blocks', 'suggests'
created_at	timestamptz	
source	text	'system' (code-created) or 'ai' (LLM-proposed)
New DB module: src/lib/db/deal-graph.ts
createNode(...), updateNodeStatus(...), getNodesForDeal(...), getBlockingNodes(dealId)
createEdge(...), getEdgesForDeal(...), removeEdge(...)
getDAG(dealId) — returns full graph (nodes + edges) for the graph walker
New service: src/services/graph-updater.ts
updateGraph(dealId, hardFacts: HardFact[]): Promise<void>
Deterministic logic: match facts to node labels → flip completed/blocked status
If a fact mentions a genuinely novel dependency type: one targeted LLM call to propose new edges
AI stage: Add graph_proposal to ai-models.ts — only fires for genuinely new dependency patterns
Graph initialization: When a new deal is created, seed the graph with deal-type-specific templates:
Sale: listing → viewings → offer → contract → financing → notary → registration
Purchase: search → viewing → offer → inspection → financing → notary → registration
Rental: listing → viewing → contract → move-in
These templates are code-defined in a new src/config/deal-templates.ts
Phase 3: Batch Planner (Runs at 8:00 and 13:00)
3.1 — Graph Walker
What it replaces:

planning.ts → generateActionProposal() and generateActionsForConversations()
lead-tracking.ts → trackLeadsForUser()
The AI triage pipeline (triageConversation → verifyTriage)
Current flow: Per conversation → fetch messages → AI triage → verify → create action. Separate lead tracking scan.

New behavior: Pure code. Walks every active deal's DAG against current time, user's calendar, and travel distances. Outputs a ranked task list with no LLM involvement.

Technical steps:

New service: src/services/graph-walker.ts
walkAllDeals(userId): Promise<GraphWalkerOutput[]>
For each active deal:
a. Load DAG via getDAG(dealId)
b. Load entity map via getEntitiesForDeal(dealId)
c. Load current beliefs via getCurrentBeliefs(dealId)
d. Identify: what's blocking (incomplete nodes with all upstream complete), what's due in 4 hours, what has slack, what creates cross-deal calendar conflicts
Input: current time, user's calendar events, travel distances (maps API)
Output:
interface GraphWalkerOutput {
  dealId: string
  tasks: WalkerTask[]
}
interface WalkerTask {
  nodeId: string
  dealId: string
  taskType: 'blocking' | 'due_soon' | 'overdue' | 'has_slack' | 'calendar_conflict' | 'lead_cooling' | 'lead_cold' | 'lead_dead'
  deadline: string | null
  hoursUntilDue: number | null
  slack: number | null  // hours of slack before it becomes urgent
  cpId: string | null
  entityMapSnapshot: Record<string, string>  // relevant facts
  beliefSnapshot: string[]  // relevant beliefs
}

Calendar integration: The walker needs to know the user's calendar. Reuse getEventsForToday(), getUpcomingEvents() from lib/db/events.ts.
Travel distance: Reuse getTravelTime() from lib/google/maps.ts for cross-deal conflict detection.
Lead tracking absorbed: No separate trackLeadsForUser. The graph walker detects stale deals by checking deal.last_activity_at against thresholds (same cooling_threshold_days, cold_threshold_days, dead_threshold_days from settings). Generates lead_cooling/lead_cold/lead_dead tasks.
Delete: services/lead-tracking.ts (absorbed into graph walker)
Delete: The triage AI pipeline (triageConversation, verifyTriage in gemini.ts) — decisions are now deterministic
3.2 — Scoring Engine
What it replaces: calculatePriorityScore() in lib/db/actions.ts (lines 369-398).

Current formula: Score = (nVal × sellerMultiplier) + (urgency × daysIgnored^1.5) + weight

New behavior: Pure code applying hard business rules to the graph walker's output. Rules:

Closing > acquisition
Seller > buyer
Deal value weighting
Personal items are included but scored separately
Technical steps:

New service: src/services/scoring-engine.ts
scoreWalkerOutput(tasks: WalkerTask[], settings: UserSettings, entities: EntityMap): ScoredTask[]
ScoredTask extends WalkerTask with score: number + scoreBreakdown: { withinDealRank: number, dealValueMultiplier: number, personalFlagBoost: number }
Business rules in code (not prompts):
Deal stage multiplier: closing phase gets 2x, acquisition gets 1x
CP role multiplier: seller × settings.offer_multiplier_seller, buyer × settings.offer_multiplier_buyer
Deal value from entity map: entities.get(dealId, 'price', 'asking_price')
Days-ignored from deal.last_activity_at: same daysIgnored^1.5 curve
Deadline proximity: tasks due in < 4 hours get maximum urgency
Personal items: scored with weight but excluded from business ranking
Keep the formula core: The (nVal × multiplier) + (urgency × daysIgnored^1.5) + weight formula is sound. The change is that inputs come from the entity map and graph, not from per-message AI triage.
Delete: mapUrgencyToNumber() in planning.ts — urgency is now derived from graph state (deadlines, blocking status), not from AI categories
Delete: shared/scoring.ts → computeDaysIgnored() — replaced by direct calculation from deal.last_activity_at
Keep: shared/scoring.ts → selectOfferMultiplier() — still needed
3.3 — Card Generator
What it replaces:

Action creation in planning.ts (the createAction() calls)
generateLeadFollowUpIntent() in mila-voice.ts
generateSchedulingIntent() in mila-voice.ts
generateBriefHeadline() in mila-voice.ts
New behavior: Takes top-ranked tasks from scoring engine, generates Reply/Event/ToDo cards. Pulls CP patterns from belief log's "current best guess" view. Adds fill-in-the-blank placeholders for unknown info.

Technical steps:

New service: src/services/card-generator.ts
generateCards(scoredTasks: ScoredTask[], settings: UserSettings): Promise<ActionCard[]>
For each scored task:
a. Determine card type: REPLY, SCHEDULE, or TODO based on node_type and taskType
b. Load CP beliefs from getCurrentBeliefs(dealId) for tone tailoring
c. One LLM call to generate card content (intent, rationale, draft skeleton)
d. Add {{ placeholders }} for questions the system can't answer
AI stage: Reuse existing drafting stage (claude-sonnet) for card text generation
Keep: mila-voice.ts → generateFinalDraft() — still needed for execution-time draft generation
Keep: Most of the action card template (action-card-template.ts) — still renders HTML cards
Modify: createAction() call — now receives deal_id instead of (or in addition to) conversation_id
Scheduling integration: SCHEDULE cards still go through optimizeScheduleActions() / scheduleSingleAction() in scheduling.ts — the card generator outputs scheduling metadata, the optimizer books holds
Phase 4: Safety Net (Per-message, cheap)
4.1 — Anomaly Detector
What it replaces: Nothing — this is new. Currently there's no per-message "deal of the year" insurance.

Technical steps:

New function: detectAnomaly(messageText: string, dealContext: DealSummary, settings: UserSettings): Promise<AnomalyResult> in new src/services/anomaly-detector.ts
New AI stage: Add anomaly to ai-models.ts — cheapest model (flash-lite)
New prompt: "Given this deal's full context and this new message, is there anything here that represents unusually high stakes, an irreversible deadline, or a deal-killing risk that might not score high on normal business rules?" → boolean + one sentence
New type:
interface AnomalyResult {
  is_anomaly: boolean
  reason: string
}

Integration: Runs on every message, after Phase 1 extraction. If is_anomaly: true → write a scoring boost flag to the deal record. The scoring engine in next batch run picks this up and elevates the deal's weight.
New column: deals.anomaly_boost (float, default 0) — added to score in next batch run, then reset to 0
Orchestration Changes
New agent pipeline (agent.ts rewrite)
The current 8-step sequential pipeline in agent.ts gets restructured into two distinct flows:

Flow A: Ingestion (24/7, per message arrival)

Step 1: Verify user credentials (keep)
Step 2: Ingest emails/WhatsApp/calendar (keep ingestion.ts, calendar-ingestion.ts)
Step 3: Deal Tagger (new — replaces threading)
Step 4: Bypass Filter (new — emergency check)
Step 5: Temporal Extractor (new)
Step 6: Fact & Belief Extractor (new — replaces enrichMessage + extractMessageFacts)
Step 7: Reconstruction Critic (new)
Step 8: Entity Map Update (new — Phase 2.1)
Step 9: Belief Log Update (new — Phase 2.2)
Step 10: Dependency Graph Update (new — Phase 2.3)
Step 11: Anomaly Detector (new — Phase 4.1)

Flow B: Batch Planner (8:00 and 13:00, triggered by QStash)

Step 1: Run Flow A first (ensure fresh data)
Step 2: Graph Walker (new — replaces planning + lead tracking)
Step 3: Scoring Engine (new — replaces calculatePriorityScore)
Step 4: Card Generator (new — replaces triage pipeline)
Step 5: Schedule Optimizer (keep — scheduling.ts)
Step 6: Brief Generation (keep — morning-brief.ts)
Step 7: Reflection (keep — reflection.ts, but input changes to deal-scoped data)

Dispatcher changes
/api/agent/dispatch currently fans out to /api/agent/run which runs the full pipeline
New: dispatcher should trigger Flow A only (ingestion + world model update)
Flow B remains on QStash schedule (8:00/13:00)
Need new endpoint: /api/planner/run for Flow B
Files to Create (new)
File	Purpose
src/services/deal-tagger.ts	Phase 1.1 — Deal assignment
src/services/bypass-filter.ts	Phase 1.2 — Emergency detection
src/services/temporal-extractor.ts	Phase 1.3 — SCATE-style time extraction
src/services/fact-extractor.ts	Phase 1.4 — Fact & Belief extraction
src/services/reconstruction-critic.ts	Phase 1.5 — Extraction quality check
src/services/entity-map-updater.ts	Phase 2.1 — Hard fact writes
src/services/belief-log-updater.ts	Phase 2.2 — Soft observation writes
src/services/graph-updater.ts	Phase 2.3 — DAG maintenance
src/services/graph-walker.ts	Phase 3.1 — DAG traversal
src/services/scoring-engine.ts	Phase 3.2 — Business rule scoring
src/services/card-generator.ts	Phase 3.3 — Card generation
src/services/anomaly-detector.ts	Phase 4.1 — Anomaly detection
src/lib/db/deals.ts	CRUD for deals table
src/lib/db/entity-map.ts	CRUD for entity_map table
src/lib/db/deal-graph.ts	CRUD for graph nodes/edges
src/config/deal-templates.ts	Default DAG templates per deal type
src/app/api/planner/run/route.ts	New endpoint for batch planner
Files to Delete or Gut
File	Action	Reason
src/services/lead-tracking.ts	Delete	Absorbed into graph walker
src/services/planning.ts	Delete	Replaced by graph walker + scoring engine + card generator
src/services/threading.ts	Gut	Keep legacy path for bulk ingestion compat. Remove assignToConversation, processTimelineEntries. Keep rebuildConversationSummary
src/shared/scoring.ts → computeDaysIgnored	Delete	Replaced by direct calc from deal.last_activity_at
src/lib/ai/gemini.ts → enrichMessage	Delete	Replaced by fact extractor
src/lib/ai/gemini.ts → extractMessageFacts	Delete	Replaced by fact extractor
src/lib/ai/gemini.ts → triageConversation	Delete	Replaced by graph walker
src/lib/ai/gemini.ts → verifyTriage	Delete	Replaced by graph walker (deterministic)
src/lib/ai/gemini.ts → classifyEmail	Keep	Still useful for initial email categorization
src/lib/ai/gemini.ts → filterEmail	Keep	Still the first gate
src/lib/ai/gemini.ts → analyzeConversation	Modify	Input changes to deal-scoped data
Files to Modify
File	Changes
src/services/agent.ts	Rewrite orchestration into Flow A / Flow B split
src/services/ingestion.ts	Remove enrichMessage calls, add deal tagger + temporal extractor + fact extractor calls
src/services/scheduling.ts	Keep mostly intact. optimizeScheduleActions and scheduleSingleAction work on action_proposals which now have deal_id
src/services/morning-brief.ts	Change from conversation-grouped to deal-grouped action ordering
src/services/reflection.ts	Input changes — gatherReflectionInput reads from deals, entity map, belief log
src/lib/ai/context.ts	buildMilaContext takes dealId instead of conversationId
src/lib/ai/mila-voice.ts	Keep all functions. Inputs change to accept deal context instead of conversation summary
src/lib/db/actions.ts	Add deal_id to action creation/queries
src/lib/db/timeline.ts	Add deal_id column, new query functions
src/lib/supabase/types.ts	Add Deal, EntityMap, DealGraphNode, DealGraphEdge types
src/config/ai-models.ts	Add stages: bypass, temporal, extraction, reconstruction_critic, graph_proposal, anomaly
New DB Tables Summary
deals — central deal record
entity_map — hard facts per deal
deal_graph_nodes — DAG nodes per deal
deal_graph_edges — DAG edges per deal
extraction_results — audit trail for fact/belief extraction runs
DB Column Additions
conversation_threads.deal_id (uuid FK → deals)
deal_timeline.deal_id (uuid FK → deals)
action_proposals.deal_id (uuid FK → deals)
journal_entries.deal_id (uuid FK → deals, nullable)
deal_timeline.temporal_data (jsonb)
deal_timeline.is_emergency (boolean, default false)
deals.anomaly_boost (float, default 0)
AI Model Config Changes (ai-models.ts)
Stage	Purpose	Recommended Model
bypass	Emergency detection	flash-lite (cheapest, fastest)
temporal	Time expression → code	flash (needs code gen ability)
extraction	Fact + belief extraction	flash → sonnet fallback
reconstruction_critic	Extraction QA	flash-lite
graph_proposal	Novel dependency edges	sonnet (rare, needs reasoning)
anomaly	Per-message anomaly check	flash-lite
card_generation	Brief card text	sonnet (Czech prose)
Removed stages: enrichment, triage_extract, triage, triage_verify (all absorbed into new stages)

Migration Order (suggested)
Schema first: Create deals, entity_map, deal_graph_nodes, deal_graph_edges, extraction_results tables. Add FK columns.
Backfill deals: 1 conversation → 1 deal for existing data.
Phase 2 first (entity map + belief log + graph): Build the world model layer. It can coexist with the current pipeline since it only adds new tables.
Phase 1 next (new ingestion pipeline): Build deal tagger, temporal extractor, fact extractor, critic. Wire into ingestion.ts alongside existing enrichment (dual-write period).
Phase 3 next (batch planner): Build graph walker, scoring engine, card generator. Run in parallel with existing planning for comparison.
Phase 4 last (anomaly detector): Simple addition, low risk.
Cutover: Once Phase 3 produces comparable/better results, remove old planning + lead-tracking + triage pipeline.
Open Questions for You
SCATE code execution: You mentioned "executable SCATE-style Python code." The codebase is TypeScript/Node.js. Do you want actual Python execution (subprocess), or is TypeScript/JS code generation acceptable? Python requires a Python runtime on Vercel (not natively available). JS execution via vm module is native.

Graph library: You mentioned "NetworkX, JSON, whatever fits your stack." Given TypeScript + Supabase, I'd recommend storing the DAG in SQL (two tables as spec'd above) and doing graph traversal in TypeScript code. No external graph library needed for a DAG walk. Agree?

"Everything new on Deal X since last processing": This implies a cursor per deal — a last_processed_at timestamp. Where should this live? On the deals table?

Push notification for bypass filter: Email only, or do you want mobile push? Email can be done with existing sendEmail(). Mobile push requires new infrastructure.

Deal merging: When two deals turn out to be about the same thing (e.g., two CPs discussing the same property), do you want merge functionality, or is flagging sufficient for V1?


<<<<<<<<<<<<<<<<< Below are updates >>>>>>>>>>>>>>>>>


Non-deal messages (reminders, doctor, form replies)
Everything is a deal. No separate code path.

A "deal" in this system is just "a thing Mila tracks." The doctor appointment is a deal with one node: "go to appointment." The form reply is a deal with one node: "respond." This avoids branching logic everywhere (if deal... else if personal... else if admin...).

Add category to the deals table:

category	Examples	Graph template	Lead tracking	Scoring
business	Property sale, rental negotiation	Full DAG (sale/purchase/rental)	Yes	Full formula
personal	Doctor, kids' concert, partner's flight	1-node graph (the event)	No	Weight only (100 = immovable)
admin	Form reply, document request, one-off question	1-2 node graph	No	Low base, deadline-driven
service	Lawyer correspondence, photographer scheduling	Short graph	No (service CPs don't go cold — already in the system)	Medium
The deal tagger classifies into a category using the same cheap LLM call that decides which deal to assign to. If it's a new message that doesn't match any deal, the tagger creates a new deal and picks the category. An admin deal with no follow-up auto-archives after 7 days.

The graph walker treats them all the same — it walks the DAG regardless. A 1-node "doctor tomorrow" DAG just produces one task: "block time." The scoring engine applies category-specific rules (personal items get weight-only scoring).

No special handling. No branching. The system is uniform.

Emergency detection — correction accepted
You're right. I misstated it. The current instant-notify cycle already fires every 5 minutes for urgency >= 9 actions. The bypass filter's added value is narrower than I described:

Current path: message arrives → ingestion (clean, classify, enrich) → threading → planning (triage AI → verify AI → create action with urgency >= 9) → [wait up to 5 min] → instant-notify poll picks it up → email sent.

With bypass filter: message arrives → ingestion (clean) → bypass filter fires immediately (1 cheap LLM call, <500ms) → if emergency → send email right now, before enrichment/threading/planning even start.

The savings: you skip the entire pipeline delay (enrichment + threading + planning = potentially 10-30 seconds) AND the up-to-5-minute wait for the next instant-notify poll. Total: up to ~5.5 minutes faster for true emergencies.

Given the 5-min cycle stays, the bypass filter fires within the ingestion step of an agent run. The agent run is triggered by the dispatcher every 5 minutes. So worst case, a true emergency waits 5 minutes (for the dispatcher) + <1 second (bypass filter) instead of 5 minutes (dispatcher) + 30 seconds (pipeline) + 5 minutes (next instant-notify poll). That's 5 seconds vs 10.5 minutes.

Worth it for "the building is on fire" scenarios. Cheap to build.

Scoring engine — expanded business rules
The current formula is a starting point. Here's what the scoring engine should actually contain, given that graph walker output is richer than per-message AI triage:

Score = (withinDealRank) × dealValueMultiplier × personalFlagBoost

The additive components rank tasks WITHIN a deal. The multipliers rank ACROSS deals.

dealImportance (replaces nVal × sellerMultiplier)
nVal = max(1, round((dollarValue / kcHighValue) * 10)) — keep this, it works
× roleMultiplier — seller × 1.5, buyer × 1.0 (configurable per user) — keep
× stageMultiplier — NEW: closing phase 2.0, active negotiation 1.5, initial contact 1.0. Derived from the deal's graph: what percentage of nodes are complete? >75% → closing phase. This replaces the current system where deal stage is AI-assessed per message — now it's computed from the graph.
timePressure (replaces urgency × daysIgnored^1.5)
deadlineUrgency × daysIgnored^1.5 — keep the curve, but urgency now comes from hard deadlines in the entity map, not from AI-assessed categories
deadlineUrgency derivation: if entity_map has a deadline → compute hours until deadline → map to 1-10 scale:
< 1 hour: 10
< 8 hours: 9
< 24 hours: 8
< 2 days: 7
< 3 days: 6
< 5 days: 5
< 7 days: 4
< 14 days: 3
14 days: 1

No deadline: 1
If no deadline in entity map, fall back to daysIgnored alone (same as lead tracking escalation)
immovability (replaces weight)
Keep weight 1-10 and 100 — same semantics
Source: graph node metadata (inherited from entity map facts about the event)
Personal events default to 100
User-created calendar events default to settings.default_event_weight (7)
graphPressure — NEW
This is where the DAG pays off. Pure code, no AI.

blockingFanout: How many downstream nodes depend on this task? If completing "get financing approval" unblocks 3 nodes (contract, notary, registration), it scores higher than a task that unblocks 0.
Formula: blockingFanout = count(downstream_pending_nodes) × 2
criticalPath: Is this task on the longest path to deal closure? If yes, add +5.
Computed via longest-path traversal of pending nodes
cpResponsiveness (from belief log): If the belief log says "this CP typically goes silent after 3 days," and we're at day 2, escalate now rather than at the default cooling threshold.
Formula: if daysIgnored >= (typical_response_days × 0.7) → add +3
stalledDealPenalty: If a deal has had NO node completions in 2× the expected cadence → add +5 to any task on that deal. This catches "forgotten" deals that aren't technically cold by the old threshold but feel stuck.
anomalyBoost — NEW
From Phase 4 anomaly detector
Added directly: deals.anomaly_boost (typically 0, set to 10-20 when anomaly detected)
Reset to 0 after the next batch planner processes it
Full formula:
function computeScore(task: ScoredTask, deal: Deal, settings: UserSettings): number {
  // ── Within-deal rank (additive — ranks tasks WITHIN a single deal) ──
  const deadlineUrgency = computeDeadlineUrgency(task.deadline) // 1-10
  const daysIgnored = daysSince(deal.last_activity_at)
  const timePressure = deadlineUrgency * Math.pow(daysIgnored, 1.5)

  const blockingFanout = task.downstreamPendingCount * 2
  const criticalPathBonus = task.isOnCriticalPath ? 5 : 0
  const cpResponsivenessBoost = computeCpResponsivenessBoost(task, deal.beliefs)
  const stalledBonus = deal.isStalledByExpectedCadence ? 5 : 0
  const graphPressure = blockingFanout + criticalPathBonus + cpResponsivenessBoost + stalledBonus

  const immovability = task.weight
  const anomaly = deal.anomaly_boost

  const withinDealRank = timePressure + graphPressure + immovability + anomaly

  // ── Cross-deal multipliers (multiplicative — ranks ACROSS deals) ──
  // A low-urgency task on a 50M deal is still more important than
  // a medium-urgency task on a 2M deal.
  const nVal = Math.max(1, Math.round((deal.dollarValue / settings.kc_high_value) * 10))
  const roleMultiplier = selectOfferMultiplier(deal.primaryCpRole, settings)
  const stageMultiplier = computeStageMultiplier(deal.graphCompletionPct)
  const dealValueMultiplier = nVal * roleMultiplier * stageMultiplier
  // Floor at 1 so personal/admin items don't get zeroed out
  const safeDealValueMultiplier = Math.max(1, dealValueMultiplier)

  // Personal items: weight-only scoring, not amplified by deal value
  const personalFlagBoost = deal.category === 'personal' ? 0.5 : 1.0

  return Math.round(withinDealRank * safeDealValueMultiplier * personalFlagBoost)
}

The additive components (timePressure, graphPressure, immovability, anomaly) rank tasks within a deal. The multiplicative components (dealValueMultiplier, personalFlagBoost) rank across deals. A low-urgency task on a 50M CZK deal outranks a medium-urgency task on a 2M CZK deal — deal value amplifies urgency, it doesn't compete with it.

gemini.ts rename
Yes, rename it. gemini.ts is misleading — it's the AI task definition layer, not Gemini-specific. The actual Gemini provider is already in lib/ai/providers/gemini.ts.

Rename: src/lib/ai/gemini.ts → src/lib/ai/tasks.ts

Risk: 23 files import from it (I can count them). But the risk is mechanical, not logical — TypeScript compiler catches every broken import. The rename is a find-and-replace of the import path. No runtime behavior changes.

Do it early in the refactor, before the big changes, so the diff is clean and reviewable. One commit, one purpose: rename file + update all import paths.

Tables and columns to delete
Tables to delete:
Table	Reason
message_embeddings	Embeddings are generated but unused for threading since the timeline-based algorithm replaced embedding-based matching. With deal-based architecture, even less relevant. Delete the table and stop generating embeddings. Saves ~$0.01/message on embedding API calls.
Columns to delete:
Table.Column	Reason
conversation_threads.embedding	Same — unused since timeline-based threading
conversation_threads.priority_score	Never written in any code I read. Dead column.
conversation_threads.messages_since_rebuild	Replaced by deal-level last_processed_at. Summary rebuilds are triggered per deal, not by message count.
messages.enriched_text	Replaced by entity_map + extraction_results. But: keep during transition period (dual-write), delete once the new pipeline is validated. Mark as "deprecated — do not read from" immediately.
Columns to keep despite temptation:
Table.Column	Why keep
conversation_threads.summary_json	Still useful as cached orientation for the card generator. Conversations still exist under deals.
messages.cleaned_text	Still needed for display and as fallback input
deal_timeline.content	Still the primary content for display and context
The "deal as a story" insight — technical impact
This is the most important clarification. Let me restate it to make sure I understand:

The buyer's story: "I'm looking for an apartment" → spans many properties (viewings of Property A, B, C), many seller CPs, plus mortgage broker, building inspector. The story ends when one property succeeds.
The seller's story: "I'm selling my apartment" → spans many buyer CPs (Buyer 1 ghosts, Buyer 2 lowballs, Buyer 3 makes an offer), plus photographer, lawyer. The story ends when one buyer closes.
They merge at closing: When Buyer 3 buys Seller's apartment, the two stories collapse into one closed transaction that continues through escrow, land registry, etc.
Does this change the data model?
Yes, in one important way: a deal can have multiple CPs, and those CPs can change over time.

The current model (action_proposals.cp_id — singular) assumes one CP per action. The new model needs:

New table: deal_participants

Column	Type	Notes
id	uuid PK	
deal_id	uuid FK	
cp_id	uuid FK	
role	text	'buyer', 'seller', 'lawyer', 'notary', 'photographer', etc.
status	text	'active', 'dropped', 'merged'
added_at	timestamptz	
dropped_at	timestamptz	null until dropped
Modified deals table — add:

Column	Type	Notes
user_role	text	'representing_seller', 'representing_buyer', 'both', 'personal', 'admin'
parent_deal_id	uuid FK	null normally. Set when two deals merge at closing — points to the merged deal.
The deal tagger implication: When a new message arrives from Buyer 3 about Seller's property, the tagger needs to find the seller's deal (which has Buyer 3 as a participant), not create a new deal. The algorithm:

Find CP → check deal_participants for active deals with this CP
Match by content (property address, deal reference) if CP has multiple active deals
Create new deal only if genuinely new
Graph implication: The seller's DAG has buyer-specific sub-branches:

[Photography done] → [Listing published] → [Viewing: Buyer 1] → [dropped]
                                          → [Viewing: Buyer 2] → [Offer: Buyer 2] → [dropped]  
                                          → [Viewing: Buyer 3] → [Offer: Buyer 3] → [Contract] → [Financing] → [Notary] → [Registration]

Graph nodes can carry a cp_id to indicate which participant they relate to. When Buyer 1 drops out, those nodes get marked skipped, not completed. The graph walker ignores skipped branches.

Merge mechanics (V1 = flag only, as you said): When deals might be the same property, flag it: "These two deals might be about the same property — merge?" Store as deals.potential_merge_with (uuid, nullable). User decides. When they merge later (V2), set parent_deal_id on the absorbed deal and transfer participants + graph nodes.

Updated deals table (final):
Column	Type	Notes
id	uuid PK	
user_id	uuid FK	
title	text	Human-readable, e.g. "Prodej bytu Dykova 17 — p. Novotný"
category	text	'business', 'personal', 'admin', 'service'
user_role	text	'representing_seller', 'representing_buyer', 'both', 'personal', 'admin'
deal_type	text	sale/purchase/rental/lease/consultation/other
status	text	'active', 'archived', 'closed', 'merged'
parent_deal_id	uuid FK nullable	Set when merged into another deal
potential_merge_with	uuid FK nullable	Flag for user to review
anomaly_boost	float default 0	From anomaly detector
last_activity_at	timestamptz	Updated on every new message
last_processed_at	timestamptz	Cursor for ingestion — "processed up to here"
created_at	timestamptz	
Summary of all revisions to the technical requirements
Non-deal messages: Everything is a deal with a category. Personal/admin deals get simple 1-node graphs. No branching logic.
Bypass filter: Fires within the agent run's ingestion step. Saves pipeline delay + up to 5-min poll wait. Email only V1.
Scoring engine: Restructured as multiplicative across deals. Additive terms (timePressure + graphPressure + immovability + anomaly) rank within a deal. Multiplicative terms (dealValue × role × stage) rank across deals. Deal value amplifies urgency, doesn't compete with it.
gemini.ts → tasks.ts: Rename early, one clean commit.
Delete: message_embeddings table, conversation_threads.embedding, conversation_threads.priority_score, conversation_threads.messages_since_rebuild. Deprecate messages.enriched_text (keep during transition).
Deal = story: Multi-CP deals via deal_participants table. Deals have user_role. DAG nodes carry optional cp_id. Buyer-specific branches can be skipped when a participant drops out. Merge = flag only V1.
Temporal DSL: TypeScript, 10-15 core functions max. Names read like natural language — `tomorrow(anchor)`, `nextWeekday(anchor, "friday")`, `atTime(date, 14, 0)`, `deadlineBefore(date)`, `dateOffset(anchor, {days: 1})` — NOT `temporalConstraintResolve(mode="before", anchor=...)`. The more the function signatures read like natural language, the more reliably the LLM generates them. **Go/no-go test**: Before building anything else, give the LLM 50 Czech temporal expressions and the DSL docs, measure what percentage produce valid executable code. Target: >90% valid. Below 80% → redesign the DSL. This test runs in isolation, no pipeline integration needed.
DAG: SQL tables, TypeScript traversal. Boring.
Cursor: deals.last_processed_at.
Push: Email V1.
Anything else missing, or shall I refine any section further?
