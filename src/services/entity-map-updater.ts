/**
 * Entity Map Updater (Chunk 6 — Phase 2.1)
 * Deterministic code: writes hard facts from ExtractionOutput into the entity_map table.
 * No LLM. Pure CRUD.
 */

import { upsertEntity } from '@/lib/db/entity-map'
import type { HardFact } from './fact-extractor'

/**
 * Write a batch of hard facts to the entity map for a deal.
 * Uses upsert semantics — newer facts overwrite older ones on the same key.
 *
 * @param userId     Owner of the deal (required for RLS)
 * @param dealId     The deal these facts belong to
 * @param hardFacts  Output from extractFactsAndBeliefs()
 */
export async function updateEntityMap(
  userId: string,
  dealId: string,
  hardFacts: HardFact[]
): Promise<void> {
  if (hardFacts.length === 0) return

  await Promise.allSettled(
    hardFacts.map(fact =>
      upsertEntity(
        userId,
        dealId,
        fact.type,
        fact.key,
        fact.value,
        fact.source_message_id,
        fact.confidence
      ).catch(err => {
        // Log but don't block — other facts should still be written
        console.error(`[EntityMapUpdater] Failed to upsert ${fact.type}.${fact.key}: ${err}`)
      })
    )
  )
}
