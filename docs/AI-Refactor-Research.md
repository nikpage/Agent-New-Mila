Plan: Fixing Mila's AI Quality — For Good
Part 1: Why 4 Refactorings in 6 Days Didn't Work
I traced the full history:

Date	Change	Why	Outcome
Apr 5 AM	Split proposeAction into triage + 3 detail functions	"500-line prompt doing 15 tasks, contradictions, attention dilution"	Wrong action types, interrogatory tone, missed deadlines
Apr 5 PM	Reverted back to single prompt	"Split fragmented decision-making"	Back to square one
Apr 9	Decomposed into 3 AI + 3 deterministic steps	"Never re-derive in AI what enrichment already extracted"	Unstable — 6+ fix commits in 2 days ("No Bob update", "stopping the lies", "tomorrow issue", "address invention")
Apr 11	Re-consolidated into 2-call triage (Sonnet+thinking → flash-lite verify)	Implied: decomposition wasn't working	Current state — unknown quality
The pattern: Each refactoring changes the structure (how many prompts, which model) but never measures the outcome (how often are triage decisions correct). Without measurement, you can't know if a change helped or hurt. You see a bad brief, assume the structure is wrong, refactor, see a different bad brief, refactor again.

This is not a structure problem. It is a measurement problem.

Every production AI team I researched (Shortwave, Notion, SaneBox, LangChain) went through this same loop early on. They all broke out of it the same way: they built an eval dataset and started measuring before changing.

Hamel Husain (ex-GitHub ML engineer, leading voice on LLM evals) calls this: "Error analysis is the most important activity in evals — it helps you decide what evals to write in the first place." Most teams skip straight to automated evals without understanding their failure modes. That is backwards.

Part 2: What Others Do That Mila Doesn't
I found 12 concrete examples from production systems. Here are the 5 most directly applicable:

1. Anthropic's "Programmatic Gates" Pattern
From Anthropic's "Building Effective Agents" research. Their recommendation for multi-step pipelines: between each AI step, add code-based validation (not another AI call). Check that urgency is in range, action type is valid, venue is from an approved list. Mila's verifyTriage is currently another AI call (flash-lite) — it should be mostly deterministic code with AI only for the things code can't check.

2. Enrichment Data as Single Source of Truth (Context Engineering)
From Anthropic's "Effective Context Engineering" and the broader context engineering paradigm. Facts extracted by enrichment should flow through the pipeline as structured data. Each subsequent step receives those facts as read-only input. Triage should never re-extract addresses, times, or prices that enrichment already found.

This is Mila's biggest structural problem. I compared the enrichment prompt and the triage prompt:

Data	Enrichment extracts it?	Triage re-extracts it?
Addresses	Yes — addresses[] array with explicit "EVERY physical address"	Yes — meeting_venue field, free-text
Proposed times	Yes — proposedTimes[] with original, interpreted, date, time	Yes — proposed_time field, free-text
Meeting type	Yes — meetingType	Yes — meeting_type field
Dollar value	Yes — keyNumbers.price	Yes — dollar_value field
Urgency signal	Yes — urgency.quote + classification	Yes — urgency score + urgency_justification
Phone number	No (but CP record has it)	Yes — cp_phone field
Triage re-extracts 5 things enrichment already extracted. Each re-extraction is a chance to hallucinate. When triage "invents" an address, it's because the prompt says "extract the meeting venue" and the AI generates one from context, even though enrichment correctly extracted the real addresses 2 pipeline steps earlier.

The April 9 decomposition was right about this principle ("never re-derive in AI what enrichment already extracted") but wrong about the implementation (it split the judgment into 3 AI calls, causing fragmentation).

3. "Pick From List" vs "Generate From Scratch" (Chain of Verification)
From Meta's Chain-of-Verification research. When you ask an AI to generate structured data from scratch, it hallucinates. When you ask it to pick from a provided list, hallucination drops dramatically. Applied to Mila: instead of "what is the meeting venue?", the prompt should say "here are the addresses enrichment found: [list]. Which one, if any, is the MEETING venue? Or null if none."

4. Behavioral Learning from User Actions (SaneBox, Reclaim AI, LangChain)
SaneBox doesn't ask "was this classification correct?" It watches what the user does. If the user moves an email from SaneLater back to inbox, that's a training signal. LangChain's email agent stores structured preferences from approval/rejection patterns.

Mila already has the data: every action is approved, dismissed, edited, or deferred. But Mila doesn't feed this back into triage decisions. If the user consistently dismisses follow-up actions for lawyers, Mila should learn to stop proposing them. Currently, the service CP bypass handles this with a hardcoded role list — but it should be data-driven.

5. Eval-Driven Development (Hamel Husain, Eugene Yan, OpenAI Cookbook)
The universal finding: start with your own labeled data, not a framework. 50 examples. For each: the input email/conversation, the correct triage decision (action type, urgency, venue), and why. Run the current pipeline against them. Measure. Make ONE change. Remeasure. If it improved, keep it. If not, revert. This transforms "refactoring" from subjective judgment into measurable experiment.

Part 3: The Specific Root Causes (What's Actually Broken)
From the commit messages, I identified these recurring quality failures:

Address hallucination — AI invents addresses not in the source email. Commits: 0100e4f ("Fix address invention"), 398740b ("address"), multiple Update gemini.ts commits.

Fact fabrication ("the lies") — AI states things not supported by the source material. Commit: 58abd9b ("Stopping the lies").

Relative date misinterpretation — "Tomorrow" parsed incorrectly. Commit: 97593b8 ("improve the tomorrow issue").

Wrong action type — REPLY when TODO is needed, or vice versa. Commits: 715dd01 ("Strengthen REPLY-vs-TODO boundary"), b858a4f ("SCHEDULE = confirmation").

Interrogatory missing_info — AI asks too many questions, feels like an interrogation. Commits: 862e80a, c1c996b ("missingInfo must never interrogate").

CP request buried — The counterparty's actual request gets lost under preparatory tasks. Commit: b01f1bc ("extract CP request first").

Urgency miscalibration — urgency too high or too low. Commit: 00a4219 ("disable urgency_review"), ba7473c ("Fix refresh pairs to never lower urgency").

Root cause of all 7: The triage prompt asks the AI to simultaneously extract facts AND make judgments. Facts 1-3 are extraction errors (addresses, dates, amounts). Judgments 4-7 are decision errors (action type, urgency, intent). Mixing them in one prompt means the AI splits attention between extracting and deciding, doing both poorly.

Part 4: The Fix
Core Principle: Separate Facts From Judgments
Enrichment extracts facts. Triage makes judgments. They never overlap.

Step 1: Feed Enrichment Data Into Triage (45 min)
Change generateActionProposal in planning.ts to:

Parse the enriched_text JSON from the latest inbound message (it's already stored on messages.enriched_text)
Extract: addresses[], proposedTimes[], meetingType, keyNumbers.price, urgency
Pass these as a structured "FACTS" block in the triage prompt
Change the triage prompt in gemini.ts to:

Add a FACTS FROM ENRICHMENT (already extracted — use these, do NOT re-extract): section
For meeting_venue: replace free-text extraction with pick-from-list. "Which address from the FACTS list, if any, is the MEETING VENUE (where people will physically meet)? Answer with the exact string from the list, or null."
For proposed_time: same pattern — pick from the enrichment list
For dollar_value: use keyNumbers.price from enrichment, triage only refines if needed
For meeting_type: use enrichment's meetingType
Remove cp_phone from triage entirely — pull from CP record in planning.ts
Remove from triage output: meeting_venue_source (no longer needed — the source is enrichment), cp_phone (from DB). Keep but constrain: meeting_venue (must be from list or null), proposed_time (must be from list or null), dollar_value (enrichment value as default, AI can adjust with justification).

This eliminates failures 1, 2, and 3 (address hallucination, fact fabrication, date misinterpretation) because the AI no longer generates these values from scratch.

Step 2: Make Urgency Evidence-Based (30 min)
Enrichment already extracts urgency signals with classification:

HARD DEADLINE — explicit date/time or stated consequence
SOFT REFERENCE — vague mention, no consequence
null — no urgency signal
Change the triage prompt to use these as anchors:

URGENCY EVIDENCE FROM ENRICHMENT:
- Signal: "potvrďte do 17:00" [HARD DEADLINE]
- OR: "bylo by fajn se potkat" [SOFT REFERENCE]  
- OR: (no urgency signal found)

CALIBRATION:
- HARD DEADLINE with today/tomorrow date → start at 8-9, adjust based on specifics
- HARD DEADLINE with date this week → start at 6-7
- SOFT REFERENCE → start at 3-4
- No signal → start at 1-2
- You may adjust ±2 from the starting point with justification

This eliminates failure 7 (urgency miscalibration) by giving the AI an evidence-based starting point instead of asking it to assess urgency from scratch.

Step 3: Replace AI Verification With Programmatic Gates + Targeted AI Check (30 min)
Replace the current verifyTriage (which asks 3 binary questions via flash-lite) with:

Programmatic (code) checks:

urgency in range 1-10 (already done)
type in ['REPLY', 'SCHEDULE', 'TODO'] (already done)
meeting_venue is either null or matches one of the enrichment addresses (NEW)
proposed_time is either null or matches one of the enrichment times (NEW)
dollar_value is non-negative and ≤ 10x typical_deal_size_max (NEW)
intent_cs is non-empty and under word limit (already partially done)
If venue or time doesn't match enrichment list: set to null, add to missing_info

AI verify (keep, but more targeted): Only ask action_justified — "Given this inbound message, is a ${type} action justified?" Skip venue and urgency verification (now handled by code). This makes the flash-lite call cheaper and more focused.

This eliminates the overcorrection problem (urgency clamped to 2 when verify says urgency_ok=false) and makes venue validation deterministic.

Step 4: Simplify the Triage Prompt (15 min)
With facts pulled from enrichment and validation handled by code, the triage prompt shrinks. Remove:

All instructions about address extraction ("WHERE PEOPLE WILL PHYSICALLY MEET, not the property...")
All instructions about time extraction
All instructions about dollar_value estimation rules
The cp_phone field entirely
The meeting_venue_source field
The triage prompt focuses on what ONLY AI can do:

Does this need action? (judgment)
What type? (judgment)
How urgent, starting from the evidence-based anchor? (judgment)
What should Mila tell the user? (writing)
Which enrichment address is the meeting venue? (selection, not extraction)
Which enrichment time is relevant? (selection, not extraction)
What's missing? (judgment)
This reduces the prompt from ~100 lines of rules to ~50, and halves the number of output fields. Shorter prompts with fewer tasks produce better results — this is well-established.

Step 5 (Optional, +30 min): Build Minimal Eval Harness
Create a file scripts/eval-triage.ts containing:

15-20 test cases (can be seeded from the commit messages — each commit that fixes a specific bug IS a test case)
Each case: a conversation context + expected triage result (action type, urgency range, venue from list or null)
Run triageConversation against each case, compare, report pass/fail
This is NOT unit tests. This is a quality measurement tool. Run it before and after any prompt change. If pass rate drops, revert.

Test cases from known bugs:

Email with address "Třinecká 672, Praha" in body → venue should be "Třinecká 672, Praha", NOT "Kancelář notáře JUDr. Procházka, Praha" (from 0100e4f)
Email with "potvrďte do 17:00" AND "schůzka zítra" → urgency should be 9-10, not 5-6 (from 0100e4f)
Confirmation email ("Děkuji, domluveno") → needs_action should be false (from triage rules)
Email where CP asks to confirm AND user needs to prepare docs → TODO should surface first (from b01f1bc)
Email with address in signature but meeting at CP's office → venue should NOT be signature address (from address inference rules)
Each past bug commit gives you a free test case. You already have ~10 from the commit history.

Part 5: Implementation Order and Timeline
If you want results in 1-2 hours:
Do Steps 1 + 2 + 3 only. These are the changes that directly eliminate the recurring failures.

Step	Time	Eliminates
1. Feed enrichment into triage	45 min	Address hallucination, fact fabrication, date misinterpretation
2. Evidence-based urgency	30 min	Urgency miscalibration
3. Programmatic gates	30 min	Overcorrection by verifyTriage, venue confusion
Total	~1h 45min	5 of 7 recurring failures
Steps 4 and 5 are cleanup and measurement — important but not urgent for the first working version.

What about failures 4 (wrong action type), 5 (interrogatory missing_info), and 6 (CP request buried)?
These are genuinely hard judgment calls where the AI needs to do better. But they get EASIER when the AI isn't also burdened with fact extraction. A prompt that only needs to decide "REPLY vs SCHEDULE vs TODO" and write intent — without also extracting venues, times, prices, and phones — will make better decisions because it can devote all its reasoning capacity to the judgment.

If these persist after Steps 1-3, the targeted fixes are:

Wrong action type: Add a mandatory decision_reasoning field that forces the AI to explicitly state "CP is asking for X, therefore action type is Y." Chain-of-thought, not just an answer.
Interrogatory missing_info: Cap at 2 items. Add rule: "missing_info asks ONLY for information Mila literally cannot find in the conversation or CP record. Never ask for something the user already told you."
CP request buried: Already handled by simpler prompt (less cognitive load = AI focuses on what matters).
Part 6: What NOT To Do
Do not split triage into multiple AI calls again. The April 5 split and April 9 decomposition both failed because splitting the JUDGMENT fragments the AI's coherent understanding of the conversation. One AI call for judgment, always.

Do not add more prompt instructions to fix edge cases. The prompt is already ~100 lines. Adding more rules creates conflicts. Instead, remove rules by handling things in code.

Do not change models. Sonnet with extended thinking for triage is the right choice. The problem is what you ask the model to do, not which model does it.

Do not refactor the whole pipeline. Steps 2→2.1→2.5→3→4→4.5→5→6→7 is sound architecture. The only broken step is 5 (triage/planning). Fix only step 5.

Part 7: My Recommendation
Do Steps 1, 2, and 3 tomorrow. They're surgical, targeted, and address the specific measured failures from your git history. They don't change the pipeline architecture. They change what data the triage prompt receives and how its output is validated.

If you want, I will implement all three steps. No structural refactoring. No new abstractions. Just:

Parse enrichment data and pass it as read-only context to triage
Restructure the triage prompt to pick from lists instead of extracting from scratch
Add code-based validation between triage and planning
Simplify verifyTriage to only check action justification
The prompt gets shorter. The output gets constrained. The hallucination surface area shrinks. The recurring bugs have no room to recur.

That's the plan. When you're back in the morning, tell me if you want me to proceed with implementation.


1 step
1 step
I wany you to use yuor trainin knowldge and online e sreach to see:

what problems types are useful to us for learning about the problems we have
confirmaton/falsification of your theires
external solution resuse
insspiation when direcrre-sue isnt possib.e
I really want ths ti me the last "Smart Bits" refactor


Ran 3 agents
Ran 3 agents

Three research agents launched and running in background. I'll compile everything once they return. This will cover your 4 points directly:

Problem types useful for learning about our problems
Confirmation/falsification of the theories from my plan
External solutions we can directly reuse
Inspiration for what can't be directly reused
I'll write a comprehensive document when all research is back.


Loaded tools, updated todo list
Loaded tools, updated todo list

Waiting for the three research agents to return. They're searching for:

Production AI email triage systems (Shortwave, Superhuman, SaneBox, Lindy, Notion, Dust.tt, Reclaim)
LLM hallucination prevention in structured pipelines (grounded generation, extractive vs abstractive, CoVe, cognitive load research)
Eval-driven AI development (metrics, behavioral learning, error taxonomy, golden datasets)
I'll compile everything once they're all back.


1 step
1 step

First research agent back (eval-driven development). Two more still running. Key findings noted — waiting for the remaining two before writing the final document.


1 step
1 step

Second agent back (hallucination prevention). Very strong findings — especially the "Format Tax" paper and the "5-8 fields per call" research. One more agent still running.


1 step
1 step

All three research agents are back. Let me compile everything now.


Updated todo list
Updated todo list

Now let me synthesize all of this. I have research from 30+ sources across production AI systems, academic papers, and practitioner guides. Let me organize it around your 4 questions.


Updated todo list
Updated todo list

The Last Smart Bits Refactor — Research-Backed Plan
1. Problem Types That Are Instructive for Mila's Issues
I found 6 documented problem types from research and production systems that directly map to what Mila is experiencing. Each has been studied, named, and solved by others.

Problem Type A: "The Dual Extraction Anti-Pattern"
What it is: Two stages in an AI pipeline independently extract the same data from the same source. They disagree. The downstream system doesn't know which to trust.

Who documented it: KGGEN framework (arXiv 2502.09956), Cresta's enterprise AI system, LangExtract research (Towards Data Science), and a context drift study (arXiv 2510.07777).

Mila's case: Enrichment extracts addresses, proposed times, meeting type, price, urgency signals. Triage re-extracts all 5 as meeting_venue, proposed_time, meeting_type, dollar_value, urgency. When they disagree, triage wins — and triage is the one more likely to hallucinate because it's simultaneously doing 10 other things.

The established solution: "Extract once, reference everywhere." Extraction stages produce immutable fact records. Decision stages receive those records as read-only context. From the KGGEN paper: their 2-step approach (detect entities → generate relations using those entities as input) "works better to ensure consistency and reduces cognitive load."

Confidence this applies: Very high. This is the single most documented anti-pattern in multi-stage LLM pipelines.

Problem Type B: "The Format Tax"
What it is: Requiring structured output (JSON) from an LLM measurably degrades its reasoning quality. The model spends tokens on formatting instead of thinking.

Who documented it: "The Format Tax" paper (arXiv 2604.03616, April 2026) — tested across 10 models, 4 formats. Also Tam et al. (EMNLP 2024) showing 10-30% performance degradation under structural constraints. Also "Thinking Before Constraining" (arXiv 2601.07525).

Mila's case: The triage prompt asks the model to simultaneously reason about what action to take AND produce a 14-field JSON structure. The format requirement competes with the reasoning.

The established solution: Separate reasoning from formatting. Either: (a) let the model reason in freeform first, then format in a second pass, or (b) use extended thinking tokens (which Mila already does with Sonnet's 3072-token thinking budget). The research shows this "recovers most lost accuracy."

Confidence this applies: High. Mila already partially mitigates this with extended thinking, but the 14+ output fields still impose a heavy format tax.

Problem Type C: "Cognitive Overload in Prompts"
What it is: LLMs suffer from the same cognitive overload as humans. Too many concurrent tasks in one prompt degrades ALL tasks.

Who documented it: ACL 2025 paper applying Cognitive Load Theory to LLMs, "Lost in the Middle" (Stanford/UW 2023, showing 30%+ degradation when information moves to middle positions), Google ICML 2023 (LLMs distracted by irrelevant context), plus a practitioner study showing 24-question prompts hallucinate while 8-question prompts work well.

The specific finding: 5-8 output fields per LLM call is the sweet spot. Beyond that, quality degrades. Single-task prompts are most reliable.

Mila's case: Triage currently asks for ~14 output fields: needs_action, reasoning, confidence, revisit_at, revisit_reason, type, intent_cs, rationale_cs, urgency, urgency_justification, what_cp_wants, meeting_venue, meeting_venue_source, meeting_venue_confidence, proposed_time, meeting_type, dollar_value, deal_type, weight, immovable, missing_info, cp_phone. That's 22 fields. Nearly 3x the recommended maximum.

The established solution: Reduce fields per call. Remove fields that can come from other sources (enrichment, DB). Keep only the judgment-only fields.

Confidence this applies: Very high. The research is unambiguous: 22 fields in one prompt is too many for any model.

Problem Type D: "Urgency Scale Calibration Failure"
What it is: LLMs are bad at numeric scoring on scales wider than 0-5. They compress toward the top of the scale and show poor discriminability between adjacent values.

Who documented it: Dedicated study on grading scales (arXiv 2601.03444) testing 0-5, 0-10, and 0-100. Also LLM bias research showing anchoring effects and inconsistency.

The specific finding: 0-5 scale has the best human-LLM alignment. 1-10 scales suffer from compression near the top and calibration drift. Binary evaluations are most reliable.

Mila's case: The urgency scale is 1-10. The commit history shows repeated urgency miscalibration (commits 00a4219, ba7473c). The triage prompt has anchor text for each level, which helps, but the scale itself is working against the model.

The established solutions: Either (a) use a coarser scale (4-5 levels: none/low/medium/high/critical) and map to numbers in code, or (b) keep 1-10 but require the model to first identify evidence, then map evidence to a calibrated starting point, adjusting only ±2.

Confidence this applies: High. The research directly explains why urgency keeps being miscalibrated despite detailed anchor text in the prompt.

Problem Type E: "Attention Dilution"
What it is: Adding tokens to a prompt monotonically increases noise. Instructions in the middle of a long prompt receive less attention than those at the start or end. Topically-related-but-irrelevant instructions are especially harmful.

Who documented it: Multiple sources including attention dilution research, context dilution analysis, and the "Lost in the Middle" paper.

Mila's case: The triage prompt includes venue extraction rules (10+ lines about "WHERE PEOPLE WILL PHYSICALLY MEET, not the property..."), which are topically related to the email content but orthogonal to the action decision. These rules steal attention from the urgency assessment and action type decision.

The established solution: Remove irrelevant tasks from the prompt entirely. Handle them elsewhere (enrichment, code).

Problem Type F: "The Measurement Void"
What it is: Making AI system changes without measuring quality before and after. Every change is a guess. Regressions are invisible until manually spotted.

Who documented it: Hamel Husain ("error analysis is the most important activity"), Eugene Yan (eval-driven development), OpenAI Cookbook (eval-driven system design), Braintrust, Promptfoo, Langfuse — literally every production AI team.

Mila's case: 4 refactorings in 6 days with 0 eval examples. No golden dataset. No regression tests on AI output. No distribution monitoring. Every change is tested by vibes.

The established solution: Build a labeled eval dataset from production traces. Start with 20-30 examples. Use Promptfoo or a custom script. Measure before and after every change.

Confidence this applies: Absolute. This is the most unanimous finding across all sources.

2. Confirmation/Falsification of Theories
Here I check each theory from my earlier plan against the external evidence.

Theory: "Triage re-extracts data enrichment already has, causing hallucination"
CONFIRMED. The "extract once, reference everywhere" pattern is documented by KGGEN, Cresta, Shortwave, and the context drift research. The KGGEN paper specifically shows that passing Stage 1 extractions as read-only input to Stage 2 "ensures consistency and reduces cognitive load." Shortwave explicitly chose to avoid chaining LLM calls for reasoning because "longer chains often introduced compounding errors and data loss at each stage."

Theory: "Too many output fields in one prompt"
CONFIRMED and the problem is worse than I thought. Research says 5-8 fields is the sweet spot. Mila's triage has 22. This is nearly 3x the researched maximum. The ACL 2025 paper validates that LLMs suffer cognitive overload analogous to human cognitive overload.

Theory: "Pick from list is better than generate from scratch for factual fields"
CONFIRMED with a caveat. OpenAI's structured outputs research shows enum/constrained values eliminate hallucinated values entirely. But the "Format Tax" paper warns that strict constraints can hurt reasoning. The solution: use enums for categorical fields (action_type, meeting_type, deal_type) and "pick from enrichment list" for factual fields (venue, times), but let the model reason freely for judgment fields (urgency, intent).

Theory: "Urgency needs evidence-based anchoring"
CONFIRMED. The grading scale research (arXiv 2601.03444) shows 1-10 scales have poor calibration. Enrichment already extracts urgency signals classified as HARD DEADLINE or SOFT REFERENCE. Passing these as anchors and constraining the model to adjust ±2 from an evidence-based starting point is exactly what the calibration research recommends.

Theory: "Programmatic gates should replace AI verification for factual fields"
CONFIRMED. The deterministic validation research is clear: code-based validation is best for format compliance, range checks, enum membership, date parsing, required fields. AI verification is only needed for semantic correctness. Anthropic's own "Building Effective Agents" guidance recommends programmatic gates between pipeline steps.

Theory: "The problem is measurement, not structure"
CONFIRMED by every single source. Hamel Husain, Eugene Yan, OpenAI Cookbook, Promptfoo, Langfuse, Braintrust — all say the same thing: you must measure before you change. The universal sequence is: collect traces → annotate failures → build taxonomy → fix top failures → remeasure. Mila has been doing: see bad output → refactor structure → hope.

Theory: "One AI call for judgment, always — never split the decision"
PARTIALLY CONFIRMED, with important nuance. Shortwave confirms: they use ONE LLM call for the final answer, not chains. Notion went the opposite way: one orchestrator model that has full context. Both approaches work. What DOESN'T work is splitting a single decision across multiple specialized prompts that each see partial context (which is exactly what the Apr 5 and Apr 9 decompositions did). The key principle: whoever makes the decision must see the full context. Whether that's one call or an orchestrator with tools is secondary.

NEW finding that modifies my plan: "Extended thinking partially solves the Format Tax"
The "Thinking Before Constraining" paper (arXiv 2601.07525) shows that letting the model reason before structuring recovers accuracy. Mila already uses extended thinking (3072 tokens) for triage. This means the format tax is partially mitigated — but NOT eliminated. The 22 output fields still impose a heavy cognitive load that extended thinking alone can't fully compensate for. Reducing fields from 22 to ~8 is still critical, even with extended thinking.

3. External Solutions That Can Be Directly Reused
These are specific, tested techniques from production systems that Mila can adopt almost verbatim.

Reusable Solution 1: "Enrichment Facts as Read-Only Context" (from KGGEN, Cresta)
What to do: Parse the enriched_text JSON from messages.enriched_text and pass it to triage as a structured FACTS block. The triage prompt says: "FACTS FROM ENRICHMENT (already extracted — use these, do NOT re-extract)."

Exactly how others do it: KGGEN Stage 2 receives "the set of entities from Stage 1 AND the source text." Cresta's AI Analyst receives "reference materials" alongside the analysis prompt. In both cases, the extraction results are immutable — the decision-maker references them but cannot change them.

What to remove from triage: meeting_venue (free-text generation), meeting_venue_source, proposed_time (free-text), meeting_type, dollar_value, cp_phone. Replace with selection/reference fields: meeting_venue_index (pick from addresses list), proposed_time_index (pick from times list).

Reusable Solution 2: "Coarser Urgency with Evidence Anchoring" (from arXiv 2601.03444)
What to do: Change urgency from a free 1-10 score to a two-step process:

Enrichment already provides urgency classification (HARD DEADLINE / SOFT REFERENCE / null) with the quoted signal
Triage receives this and assigns urgency from a narrower range:
HARD DEADLINE + today/tomorrow → 8-10
HARD DEADLINE + this week → 6-8
SOFT REFERENCE → 3-5
No signal → 1-3
The model picks within the ±2 range with justification
This is exactly the "anchor then adjust" pattern from the calibration research. It eliminates the worst miscalibrations (urgency 3 for a "confirm by 5pm" email) because the enrichment evidence constrains the range.

Reusable Solution 3: "Promptfoo for Regression Testing" (from Promptfoo, open source)
What to do: Install npx promptfoo, create a YAML file with 15-20 test cases sourced from Mila's git history of known bugs. Each test case: input conversation + expected triage result + assertions (action type equals X, urgency in range Y-Z, venue is from list or null).

Existing test cases from commit history (free — already documented):

0100e4f: Address "Třinecká 672, Praha" in body → venue must be verbatim, not paraphrased
0100e4f: "potvrďte do 17:00" + "schůzka zítra" → urgency 9-10
97593b8: "tomorrow" → correct date resolution
715dd01: REPLY-vs-TODO boundary cases
862e80a: missingInfo must not interrogate
b01f1bc: CP's request must be item #1 in TODO
b858a4f: SCHEDULE = confirmation, not TODO
58abd9b: Draft must not contain fabricated facts
Each past bug is a free regression test.

Reusable Solution 4: "Implicit Feedback from User Actions" (from SaneBox, LangChain)
What to do: Log every user action (approve, dismiss, edit, "do it myself") with the action_id, urgency, type, and CP. Compute weekly: approve-without-edit rate (target: 70%+), dismiss rate (target: <15%), edit patterns (what users consistently change).

SaneBox's exact mechanism: user moves email from AI-assigned folder to different folder → training signal. Applied to Mila: user dismisses action → negative signal for that action type + CP combination. User approves without edit → positive signal. User edits urgency down → urgency calibration signal.

This requires no AI. It's SQL queries on action_proposals tracking status changes over time.

Reusable Solution 5: "Deterministic Validation Gates" (from Anthropic, production best practice)
What to do: After triage returns JSON, before creating the action:

Code checks (not AI):
- meeting_venue is null OR matches one of enrichment.addresses[]
- proposed_time is null OR matches one of enrichment.proposedTimes[]
- dollar_value >= 0 AND <= 10x typical_deal_size_max
- urgency is within the evidence-anchored range (±2 of starting point)
- intent_cs word count ≤ 20 for REPLY/SCHEDULE, ≤ 4 items for TODO
- type is REPLY | SCHEDULE | TODO

If venue or time doesn't match enrichment list → set to null, add to missing_info
If urgency outside anchored range → clamp to nearest edge

This replaces most of what verifyTriage currently does with deterministic code. Keep verifyTriage only for action_justified (the one thing code can't check).

4. Inspiration Where Direct Reuse Isn't Possible
These are patterns from other systems that don't map directly to Mila but suggest valuable directions.

Inspiration 1: Shortwave's "Single LLM Call for Final Answer"
Shortwave explicitly rejected prompt chaining for their answer generation. They fetch all needed data with tool calls, then make ONE LLM call with all context. Their reasoning: "longer chains often introduced compounding errors and data loss at each stage."

How this inspires Mila: The current pipeline (enrichment → triage → verify) is a 3-call chain for making one decision per conversation. The research confirms: the fewer LLM calls in the decision chain, the better. After removing factual extraction from triage (handled by enrichment) and replacing AI verification with code gates, the chain becomes effectively: enrichment (factual extraction) → triage (judgment only). That's 2 calls, one for facts and one for judgment, which is the minimum necessary decomposition.

Inspiration 2: Notion's "Tear Down and Rebuild Around Reasoning"
Notion found that patching prompt chains hit diminishing returns. They rebuilt from scratch around a central reasoning model that has full context and decides dynamically what to do. Their head of AI modeling: "Rather than trying to retrofit into what we were building, we wanted to play to the strengths of reasoning models."

How this inspires Mila: The extended thinking in triage (3072 tokens) is already moving in this direction — letting a reasoning model think deeply about one conversation. The fix isn't more structure or more stages. It's giving the model LESS to do (fewer output fields) so its reasoning capacity focuses on the actual judgment. Notion's lesson: simplify the architecture, trust the reasoning model, give it the right context.

Inspiration 3: SaneBox's "Metadata-Only Classification"
SaneBox never reads email content. It classifies using only sender, subject, timestamps, and interaction patterns. This eliminates hallucination entirely because the model never sees free text to misinterpret.

How this inspires Mila: Mila can't go metadata-only (it needs to understand deal context), but the principle applies: the less raw text the decision model processes, the less it can hallucinate about. By passing enriched/structured facts instead of raw email text to triage, Mila moves partially toward this pattern. The triage model still sees the latest inbound message (necessary for judgment), but it no longer needs to hunt through it for addresses, dates, and prices — those are pre-extracted.

Inspiration 4: Reclaim AI's "Priority Boosting From Missed Actions"
Reclaim auto-escalates priority when a user misses or skips an event repeatedly. A Medium priority habit that gets skipped for 3 weeks becomes High.

How this inspires Mila: If a user ignores an action in 2 consecutive briefs (neither approves, edits, nor dismisses), Mila could boost its urgency by 1. If a user consistently dismisses follow-ups for a certain CP, Mila could learn to stop proposing them (or lower their priority). This is a future enhancement, not part of the immediate fix, but it closes the feedback loop.

Inspiration 5: Dust.tt's "Brain/Hands Separation"
Dust separates the "brain" (decides what to do) from the "hands" (executes tools). The brain never executes; the hands never decide. They communicate through a database — the single source of truth.

How this inspires Mila: Mila's triage is currently both brain (decides action type, urgency) and hands (extracts venue, time, price). Separating these mirrors Dust's pattern. Enrichment = hands (extracts facts). Triage = brain (makes decisions using facts). Planning.ts = orchestrator (validates, persists, scores). Each has one job.

The Updated Plan — What Changes From Yesterday
Based on the research, the plan from yesterday holds up well. Three modifications:

Modification 1: Reduce output fields more aggressively (research says 5-8, not just "fewer")
Yesterday I said "halve the output fields." The research says Mila's 22 fields should go to 5-8. That's more aggressive. The triage output should be:

Field	Keep/Remove	Why
needs_action	KEEP	Core judgment
reasoning	KEEP	Chain-of-thought for debugging
confidence	KEEP	Gate threshold
type	KEEP	Core judgment
intent_cs	KEEP	Core output (writing)
rationale_cs	KEEP	User-facing explanation
urgency	KEEP (but constrained)	Core judgment, evidence-anchored
urgency_justification	KEEP	Required for calibration
what_cp_wants	KEEP	Grounds the decision
weight	KEEP	Scheduling judgment
missing_info	KEEP	User-facing questions
meeting_venue	REMOVE → pick from enrichment list	Dual extraction
meeting_venue_source	REMOVE	Source is enrichment
meeting_venue_confidence	REMOVE → code checks geocoding	Dual extraction
proposed_time	REMOVE → pick from enrichment list	Dual extraction
meeting_type	REMOVE → from enrichment	Dual extraction
dollar_value	REMOVE → from enrichment keyNumbers.price	Dual extraction
deal_type	MOVE → derive from enrichment subject/context	Low-value for triage
immovable	MERGE into weight (100 = immovable)	Already how it's used
cp_phone	REMOVE → from CP record	Should never be AI-extracted
revisit_at/reason	KEEP (conditional)	Snooze judgment
After: 11 core judgment fields + 2 conditional (revisit). Plus 2 "pick from list" fields (venue_index, time_index) that are selection, not generation. That's ~13 total, down from 22. Still above the 5-8 ideal, but the judgment fields can't be further reduced and the selection fields have near-zero cognitive cost.

Modification 2: Add two "pick from list" fields instead of removing venue/time entirely
Yesterday I said "pull venue and time from enrichment in code." The research on selection-vs-generation says: letting the model SELECT from a list is nearly as reliable as deterministic code AND preserves the model's ability to apply judgment (e.g., "this address is the meeting venue, not that one"). So instead of removing venue/time from triage entirely, I add:

Which of these addresses is the MEETING VENUE (where people will meet)?
0: Třinecká 672, Praha
1: Dykova 17, Praha 2
Answer: 0, 1, or null

Which proposed time is the MEETING TIME?
0: zítra v 14:00 (2026-04-13 14:00)
1: v pátek (2026-04-18)
Answer: 0, 1, or null

This is the "pick from list" pattern. The model can't hallucinate an address that enrichment didn't find. It can still apply judgment about WHICH address is the venue.

Modification 3: Use 4-level urgency categories mapped to numbers in code
The calibration research says 0-5 is optimal. But Mila's priority formula uses the 1-10 value for scoring. Compromise: the model outputs a CATEGORY, code maps to a number:

Urgency category (based on enrichment evidence):
- CRITICAL: Must act within hours (→ urgency 9-10 in code)
- TODAY: Must act by end of business today/tomorrow (→ urgency 7-8)
- THIS_WEEK: Must act within the week (→ urgency 5-6)
- SOON: Within 2 weeks, no hard deadline (→ urgency 3-4)
- NONE: No time pressure (→ urgency 1-2)

Within each category, code uses the enrichment urgency signal to pick the specific number:
- HARD DEADLINE → top of range (e.g., CRITICAL + hard deadline = 10)
- SOFT REFERENCE → middle of range (e.g., TODAY + soft reference = 7)  
- No signal → bottom of range (e.g., SOON + no signal = 3)

The model makes a coarser judgment (5 categories vs 10 numbers), which the research shows it's better at. Code handles the fine-grained mapping.

Implementation Summary
Step	Time	What	Eliminates
1. Parse enrichment JSON, pass as read-only FACTS to triage	30 min	Code change in planning.ts	Dual extraction anti-pattern
2. Replace free-text extraction with pick-from-list	30 min	Prompt change in gemini.ts	Address hallucination, date misinterpretation
3. Replace 1-10 urgency with 5 categories + code mapping	20 min	Prompt change + code in planning.ts	Urgency miscalibration
4. Remove 10 fields from triage output	15 min	Prompt change in gemini.ts	Cognitive overload (22→13 fields)
5. Replace AI verification with code gates	20 min	Code change in planning.ts	Overcorrection, unnecessary AI call
6. Create 15 Promptfoo test cases from git history	30 min	New file	The measurement void
Total	~2.5h		All 6 documented problem types addressed
Every step is backed by external research. No guessing. No structural rearrangement. No new abstractions. Just: pass the right data to the right prompt, ask for fewer things, validate with code.
