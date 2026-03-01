# Implementation Plan: Pinning Tests + Tamper Protection

## Significant Deltas from Discussion

1. **Priority scoring tests (Test 1) already exist** — `src/lib/db/actions.test.ts` has 17 comprehensive pinning tests. No new work needed here.
2. **`tag_primary`/`tag_secondary` are NOT dead columns** — `threading.ts:185` reads `tag_primary === 'bulk_import'` to suppress thin-conversation ToDo creation during historical import. Test 4 changes from "confirm dead" to "pin this live read behavior."
3. **Lead tracking tests exist but are shallow** — `lead-tracking.test.ts` only pins `DEFAULT_USER_SETTINGS` constants and hardcoded urgency/pain values. It never calls `getLeadStatus()` (which IS exported). Need to add actual function-level tests.
4. **Threading constants are module-private** — `SIMILARITY_THRESHOLD` (0.78), `TIEBREAKER_THRESHOLD` (0.55), and `cosineSimilarity()` are not exported. We must either export them or test through `assignToConversation` with mocked dependencies.
5. **No CI workflow for tests** — Only `cron.yml` exists. No test/build CI pipeline to add guardrails to. We'll create one.
6. **No `.github/CODEOWNERS`** — Needs to be created from scratch.

---

## Step 1: Export threading internals for testability

**File:** `src/services/threading.ts`

- Export `cosineSimilarity` function (rename to keep it clear it's internal: add `/** @internal — exported for testing */` JSDoc)
- Export `SIMILARITY_THRESHOLD` and `TIEBREAKER_THRESHOLD` constants

These are pure functions/values with no side effects — safe to export.

---

## Step 2: Create `src/services/threading.test.ts`

**New file.** Tests:

### 2a. Cosine similarity pinning
- Identical vectors → 1.0
- Orthogonal vectors → 0.0
- Known vectors → exact numeric result
- Different-length vectors → 0
- Zero vector → 0

### 2b. Threshold constant pinning
- `SIMILARITY_THRESHOLD` === 0.78
- `TIEBREAKER_THRESHOLD` === 0.55
- `SIMILARITY_THRESHOLD > TIEBREAKER_THRESHOLD` (ordering invariant)

### 2c. Threading decision flow (via `assignToConversation` with mocks)
Mock all DB calls (`findConversationByExternalThread`, `updateMessage`, `incrementMessageCount`, etc.) and AI calls (`extractTopic`, `shouldJoinConversation`, `generateMessageEmbedding`).

Three scenarios:
1. **External thread ID match** — message with `external_thread_id` finds existing conversation → joins it, no embedding check
2. **High similarity (≥ 0.78)** — no external thread ID, embedding returns similarity 0.85 → auto-joins without AI tiebreak
3. **Mid similarity (0.55–0.78)** — embedding returns 0.65 → calls `shouldJoinConversation` AI tiebreaker
4. **Low similarity (< 0.55)** — embedding returns 0.40 → creates new conversation
5. **No CP** — message without `cp_id` skips embedding, creates new conversation

### 2d. Thin conversation ToDo pinning
- `tag_primary === 'bulk_import'` suppresses ToDo creation
- Short enriched_text (< 100 chars) triggers ToDo
- Null enriched_text does NOT trigger ToDo (not yet enriched ≠ thin)

---

## Step 3: Enhance `src/services/lead-tracking.test.ts`

Add to existing file:

### 3a. `getLeadStatus()` function-level pinning
Actually call the exported function with `DEFAULT_USER_SETTINGS`:
- 0 days → 'active'
- 1 day → 'active'
- 2 days → 'cooling' (boundary)
- 4 days → 'cooling'
- 5 days → 'cold' (boundary)
- 13 days → 'cold'
- 14 days → 'dead' (boundary)
- 100 days → 'dead'

### 3b. Boundary precision tests
- 1.99 days (rounds to 1) → 'active'
- 2.0 days → 'cooling'
- 4.99 days (rounds to 4) → 'cooling'
- 5.0 days → 'cold'

### 3c. Dead boost formula pinning
- Dead boost = `cold_priority_boost * 1.5` (hardcoded in lead-tracking.ts:195)
- Pin the exact computation, not just the result

---

## Step 4: Add `tag_primary` read-behavior pinning to threading tests

In `src/services/threading.test.ts` (from Step 2):
- Verify that a message with `tag_primary = 'bulk_import'` and short `enriched_text` does NOT create a thin-conversation ToDo
- Verify that a message with `tag_primary = null` (or any other value) and short `enriched_text` DOES create a ToDo

This pins the only live read of `tag_primary`.

---

## Step 5: Add CLAUDE.md tamper-protection rule

**File:** `CLAUDE.md` — Add to the `## RULES` section:

```
- NEVER modify expected values in pinning tests (files matching *.test.ts that contain "pinning" or "Pinning" in describe blocks). If a pinning test fails, REPORT the failure and WAIT. Do not update the test to match new output.
```

---

## Step 6: Create `.github/CODEOWNERS`

**New file:** `.github/CODEOWNERS`

```
# Pinning tests — require explicit review before merge
src/lib/db/actions.test.ts       @nikpage
src/services/lead-tracking.test.ts @nikpage
src/services/threading.test.ts   @nikpage
```

---

## Step 7: Create CI workflow for tests + pinning-test change detection

**New file:** `.github/workflows/ci.yml`

- Triggers on: push to main, all PRs
- Job 1: `npm test && npm run build`
- Job 2: Pinning test guardrail — runs `git diff` against base branch, checks if any pinning test files changed, and adds a PR comment warning: "PINNING TEST VALUES CHANGED — requires manual justification"

---

## Step 8: Run `npm test && npm run build`

Verify all 291+ tests pass including the new ones. Fix any issues.

---

## File Change Summary

| File | Action |
|------|--------|
| `src/services/threading.ts` | Edit — export 2 constants + 1 function |
| `src/services/threading.test.ts` | **Create** — ~150 lines |
| `src/services/lead-tracking.test.ts` | Edit — add ~50 lines |
| `CLAUDE.md` | Edit — add 1 rule |
| `.github/CODEOWNERS` | **Create** — 4 lines |
| `.github/workflows/ci.yml` | **Create** — ~40 lines |

**Total: 2 edits, 3 new files.**
