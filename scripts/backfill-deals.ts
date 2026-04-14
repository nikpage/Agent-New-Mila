/**
 * Backfill script: create one deal per existing conversation_thread (1:1 mapping).
 *
 * For each conversation_thread:
 *   1. Create a deals row (title=topic, category='business', deal_type from thread)
 *   2. Set conversation_threads.deal_id = new deal id
 *   3. Set deal_timeline.deal_id for all entries in that conversation
 *   4. Set action_proposals.deal_id for all actions in that conversation
 *   5. Copy thread_participants → deal_participants
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/backfill-deals.ts
 *
 * Idempotent: skips conversations that already have deal_id set.
 */

import * as dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.join(__dirname, '../.env.local') })

// Must come after dotenv so SUPABASE_URL etc. are loaded
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY!

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function main() {
  console.log('Starting deals backfill...')

  // Fetch all conversations that don't have a deal_id yet
  const { data: threads, error: threadsError } = await supabase
    .from('conversation_threads')
    .select('id, user_id, topic, deal_type, status, last_updated, created_at')
    .is('deal_id', null)
    .order('created_at', { ascending: true })

  if (threadsError) throw new Error(`Failed to fetch threads: ${threadsError.message}`)
  if (!threads || threads.length === 0) {
    console.log('No conversations to backfill. Done.')
    return
  }

  console.log(`Found ${threads.length} conversations to backfill.`)

  let created = 0
  let skipped = 0
  let errors = 0

  for (const thread of threads) {
    try {
      // 1. Create deal
      const { data: deal, error: dealError } = await supabase
        .from('deals')
        .insert({
          user_id: thread.user_id,
          title: thread.topic || 'Untitled deal',
          category: 'business',
          user_role: 'representing_seller',
          deal_type: thread.deal_type ?? null,
          status: thread.status === 'archived' ? 'archived' : 'active',
          last_activity_at: thread.last_updated ?? thread.created_at ?? null,
          created_at: thread.created_at ?? new Date().toISOString(),
        })
        .select('id')
        .single()

      if (dealError) throw new Error(`create deal: ${dealError.message}`)
      const dealId = deal.id

      // 2. Set conversation_threads.deal_id
      const { error: threadUpdateError } = await supabase
        .from('conversation_threads')
        .update({ deal_id: dealId })
        .eq('id', thread.id)

      if (threadUpdateError) throw new Error(`update thread: ${threadUpdateError.message}`)

      // 3. Set deal_timeline.deal_id for all entries in this conversation
      const { error: timelineError } = await supabase
        .from('deal_timeline')
        .update({ deal_id: dealId })
        .eq('conversation_id', thread.id)

      if (timelineError) throw new Error(`update timeline: ${timelineError.message}`)

      // 4. Set action_proposals.deal_id for all actions in this conversation
      const { error: actionsError } = await supabase
        .from('action_proposals')
        .update({ deal_id: dealId })
        .eq('conversation_id', thread.id)

      if (actionsError) throw new Error(`update actions: ${actionsError.message}`)

      // 5. Copy thread_participants → deal_participants
      const { data: participants, error: participantsError } = await supabase
        .from('thread_participants')
        .select('cp_id')
        .eq('thread_id', thread.id)

      if (participantsError) throw new Error(`fetch participants: ${participantsError.message}`)

      if (participants && participants.length > 0) {
        const dealParticipants = participants.map(p => ({
          deal_id: dealId,
          cp_id: p.cp_id,
          role: null as string | null,
          status: 'active',
          added_at: new Date().toISOString(),
        }))

        const { error: dpError } = await supabase
          .from('deal_participants')
          .insert(dealParticipants)

        if (dpError) throw new Error(`insert deal_participants: ${dpError.message}`)
      }

      created++
      if (created % 50 === 0) console.log(`  ${created}/${threads.length} done...`)
    } catch (err) {
      console.error(`  FAILED thread ${thread.id}: ${err}`)
      errors++
    }
  }

  console.log(`\nDone.`)
  console.log(`  Created: ${created}`)
  console.log(`  Skipped: ${skipped}`)
  console.log(`  Errors:  ${errors}`)

  // Verification counts
  const { count: dealCount } = await supabase
    .from('deals')
    .select('*', { count: 'exact', head: true })

  const { count: threadCount } = await supabase
    .from('conversation_threads')
    .select('*', { count: 'exact', head: true })

  const { count: linkedCount } = await supabase
    .from('conversation_threads')
    .select('*', { count: 'exact', head: true })
    .not('deal_id', 'is', null)

  console.log(`\nVerification:`)
  console.log(`  conversation_threads total: ${threadCount}`)
  console.log(`  deals total:                ${dealCount}`)
  console.log(`  threads with deal_id:       ${linkedCount}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
