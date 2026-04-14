/**
 * Belief Log Updater (Chunk 6 — Phase 2.2)
 * Appends soft observations to journal_entries scoped to a deal.
 * Append-only — never overwrites. Detects contradictions by comparing new
 * content against existing entries on the same topic.
 */

import { createJournalEntry, findMatchingEntry, recordConflict } from '@/lib/db/journal'
import type { SoftObservation } from './fact-extractor'

/**
 * Append soft observations from an extraction run to the belief log.
 *
 * For each observation:
 *   1. Look for an existing non-stale entry with the same deal + topic.
 *   2. If found and content differs → call recordConflict on the old entry.
 *   3. Always append the new entry (beliefs are append-only).
 *
 * @param userId        Owner of the deal
 * @param dealId        The deal these observations belong to
 * @param observations  Soft observations from extractFactsAndBeliefs()
 * @param language      Language for the journal entry (from user settings)
 */
export async function updateBeliefLog(
  userId: string,
  dealId: string,
  observations: SoftObservation[],
  language: string = 'Czech'
): Promise<void> {
  if (observations.length === 0) return

  for (const obs of observations) {
    try {
      // Check for existing entry on this topic for this deal
      const existing = await findMatchingEntry(userId, 'deal_id', dealId, obs.topic)

      if (existing && normalise(existing.content) !== normalise(obs.content)) {
        // Content changed — flag the old entry as contradicted
        await recordConflict(existing.id).catch(err =>
          console.warn(`[BeliefLogUpdater] recordConflict failed for ${existing.id}: ${err}`)
        )
      }

      // Always append — belief log is append-only
      await createJournalEntry({
        user_id: userId,
        scope: 'deal_id',
        scope_ref: dealId,
        deal_id: dealId,
        type: 'observation',
        topic: obs.topic,
        content: obs.content,
        weight: obs.confidence,
        language,
      })
    } catch (err) {
      // Log but don't block — other observations should still be written
      console.error(`[BeliefLogUpdater] Failed to append observation "${obs.topic}": ${err}`)
    }
  }
}

/** Normalise for contradiction comparison: lowercase + collapse whitespace */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}
