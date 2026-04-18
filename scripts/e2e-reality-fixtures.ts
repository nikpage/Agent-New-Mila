/**
 * E2E Reality fixtures — chronologically-ordered emails for production-realism testing.
 *
 * Reuses the same hand-authored Czech scenarios from e2e-fixtures.ts:
 *   - Phase 0: history threads bulk-loaded as backdrop (same as pipeline test)
 *   - Phase 1: current emails arrive ONE AT A TIME, each fully processed before
 *     the next. Order matters — it determines what each email "sees" in the
 *     world model.
 *
 * Each REALITY_EMAIL has a `cpKey` used by the assertion dispatcher in
 * e2e-reality.ts to pick which checks run after it lands.
 */

import {
  ALL_HISTORY_THREADS,
  SELF_EMAIL_COMMAND,
  TEST_EMAILS,
  HIGH_PRIORITY_EMAIL,
  type FixtureCurrentEmail,
} from './e2e-fixtures'

// Re-export for the runner.
export { ALL_HISTORY_THREADS, SELF_EMAIL_COMMAND }

export type RealityEmail = FixtureCurrentEmail

/**
 * Current emails in realistic chronological arrival order.
 *
 * Rationale:
 *  1. tomas      — re: vacation, blocks his original viewing window
 *  2. lawyer     — Krejčí kicks off contract review, requests docs
 *  3. bob        — cold inbound inquiry, low urgency
 *  4. martin     — Smíchov deal, change of close-by date
 *  5. eva        — Sokolovská signing push, asks for tomorrow morning call
 *  6. urgent     — Novotný URGENT signing tomorrow at notary, climax
 *
 * Reorder freely — the assertion dispatcher keys on cpKey, not position.
 */
export const REALITY_EMAILS: RealityEmail[] = [
  TEST_EMAILS.find(e => e.cpKey === 'tomas')!,
  TEST_EMAILS.find(e => e.cpKey === 'lawyer')!,
  TEST_EMAILS.find(e => e.cpKey === 'bob')!,
  TEST_EMAILS.find(e => e.cpKey === 'martin')!,
  TEST_EMAILS.find(e => e.cpKey === 'eva')!,
  HIGH_PRIORITY_EMAIL,
]
