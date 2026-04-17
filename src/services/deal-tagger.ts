/**
 * Deal Tagger (Chunk 7a — Phase 1.1)
 *
 * Replaces threading.ts → assignToConversation() for the new deal-centric pipeline.
 *
 * Algorithm (mirrors threading but targets deals, not conversations):
 *   1. External thread ID fast path → findDealByExternalThread
 *   2. Count active deals for this CP: 0 = create new, 1 = assign directly
 *   3. Multiple deals → AI picks the best match or returns "NEW"
 *   4. "NEW" or no CP → create a new deal
 */

import { runAITask } from '@/lib/ai/runner'
import {
  findDealByExternalThread,
  getActiveDealsForCP,
  createDeal,
  updateDeal,
} from '@/lib/db/deals'
import { addDealParticipant } from '@/lib/db/deal-participants'
import { getMessageById } from '@/lib/db/messages'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import type { DealTimelineEntry, Deal } from '@/lib/supabase/types'

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Tag a timeline entry to the correct deal.
 *
 * Returns the matching deal (existing or freshly created).
 * On any unexpected error the function creates a new deal rather than blocking
 * ingestion — same fail-open pattern as threading.ts.
 *
 * Side-effect: writes deal_id + last_activity_at back to the deal row and
 * updates deal_timeline.deal_id via Supabase.
 */
export async function tagMessageToDeal(
  entry: DealTimelineEntry,
  userId: string
): Promise<Deal> {
  try {
    // ── Step 1: External thread ID fast path ──────────────────────────────────
    if (entry.message_id) {
      const deal = await externalThreadLookup(userId, entry.message_id)
      if (deal) {
        await writebackDealId(entry.id, deal.id)
        await touchDeal(deal.id)
        await linkParticipant(deal.id, entry.cp_id)
        return deal
      }
    }

    // ── Step 2: CP deal count ─────────────────────────────────────────────────
    if (!entry.cp_id) {
      // No CP → untaggable (system message, etc.) → create a holding deal
      return await createNewDeal(userId, entry)
    }

    const activeDeals = await getActiveDealsForCP(userId, entry.cp_id)

    if (activeDeals.length === 0) {
      const deal = await createNewDeal(userId, entry)
      await writebackDealId(entry.id, deal.id)
      return deal
    }

    if (activeDeals.length === 1) {
      const deal = activeDeals[0]
      await writebackDealId(entry.id, deal.id)
      await touchDeal(deal.id)
      await linkParticipant(deal.id, entry.cp_id)
      return deal
    }

    // ── Step 3: AI assignment ─────────────────────────────────────────────────
    const matched = await aiPickDeal(entry, activeDeals)
    if (matched) {
      await writebackDealId(entry.id, matched.id)
      await touchDeal(matched.id)
      await linkParticipant(matched.id, entry.cp_id)
      return matched
    }

    // ── Step 4: Unresolved → new deal ─────────────────────────────────────────
    const newDeal = await createNewDeal(userId, entry)
    await writebackDealId(entry.id, newDeal.id)
    return newDeal
  } catch (err) {
    console.error(`[DealTagger] Unexpected error for entry ${entry.id}, creating new deal:`, err)
    return await createNewDeal(userId, entry).catch(e => {
      throw new Error(`[DealTagger] Failed to create fallback deal: ${e}`)
    })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function externalThreadLookup(
  userId: string,
  messageId: string
): Promise<Deal | null> {
  try {
    const message = await getMessageById(messageId)
    if (!message?.external_thread_id) return null
    return await findDealByExternalThread(userId, message.external_thread_id)
  } catch {
    return null
  }
}

async function aiPickDeal(
  entry: DealTimelineEntry,
  candidates: Deal[]
): Promise<Deal | null> {
  const entryPreview = (entry.content ?? '').slice(0, 500)
  const dealLines = candidates
    .map((d, i) => `  ${i}. [${d.id}] "${d.title || 'No title'}" (${d.deal_type ?? 'unknown'}, ${d.status})`)
    .join('\n')

  const prompt = `You are assigning a new message to the correct deal for a real estate professional.

NEW MESSAGE: [${entry.event_type}] [${entry.direction}] ${entry.occurred_at}: ${entryPreview}

CANDIDATE DEALS:
${dealLines}

Which deal does this message belong to?
- If it clearly belongs to one of the existing deals, respond with ONLY the deal UUID (e.g. "abc123...").
- If it does not belong to any existing deal, respond with ONLY "NEW".`

  let raw: string
  try {
    raw = await runAITask('threading', prompt)
  } catch (err) {
    console.warn(`[DealTagger] AI assignment failed for entry ${entry.id}: ${err}`)
    return null
  }

  const trimmed = raw.trim()
  if (trimmed === 'NEW') return null

  const matched = candidates.find(d => trimmed.includes(d.id))
  return matched ?? null
}

async function createNewDeal(userId: string, entry: DealTimelineEntry): Promise<Deal> {
  const title = entry.content
    ? entry.content.slice(0, 100).trim()
    : 'New deal'

  const deal = await createDeal({
    user_id: userId,
    title,
    status: 'active',
    category: 'business',
    deal_type: null,
    last_activity_at: entry.occurred_at,
  })

  await linkParticipant(deal.id, entry.cp_id)
  return deal
}

async function linkParticipant(dealId: string, cpId: string | null | undefined): Promise<void> {
  if (!cpId) return
  try {
    await addDealParticipant(dealId, cpId)
  } catch (err) {
    console.warn(`[DealTagger] addDealParticipant failed for deal=${dealId} cp=${cpId}: ${err}`)
  }
}

async function writebackDealId(entryId: string, dealId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('deal_timeline')
    .update({ deal_id: dealId })
    .eq('id', entryId)

  if (error) {
    console.warn(`[DealTagger] Failed to write deal_id back to entry ${entryId}: ${error.message}`)
  }
}

async function touchDeal(dealId: string): Promise<void> {
  await updateDeal(dealId, { last_activity_at: new Date().toISOString() }).catch(err =>
    console.warn(`[DealTagger] Failed to touch deal ${dealId}: ${err}`)
  )
}
