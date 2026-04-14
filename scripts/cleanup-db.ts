#!/usr/bin/env npx tsx
/**
 * Truncate all user data tables (except users).
 *
 * Usage:
 *   npx tsx scripts/cleanup-db.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

// Tables in FK-safe deletion order (children before parents)
const TABLES = [
  'audit_logs',
  'user_agent_locks',
  'message_embeddings',
  'thread_participants',
  'deal_participants',
  'deal_graph_edges',
  'deal_graph_nodes',
  'action_proposals',
  'deal_timeline',
  'journal_entries',
  'todos',
  'events',
  'emails',
  'messages',
  'cp_states',
  'conversation_threads',
  'deals',
  'cps',
  'channels',
  'agent_errors',
] as const

async function main() {
  log('Deleting all data (except users)...')

  for (const table of TABLES) {
    const { error, count } = await supabase
      .from(table)
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')  // delete all rows
      .select('*', { count: 'exact', head: true })

    if (error) {
      // Some tables use user_id as PK (e.g. user_agent_locks) — try alternate delete
      const { error: e2 } = await supabase
        .from(table)
        .delete()
        .gte('created_at', '1970-01-01')

      if (e2) {
        log(`  ${table}: FAILED — ${e2.message}`)
      } else {
        log(`  ${table}: cleared`)
      }
    } else {
      log(`  ${table}: ${count ?? '?'} rows deleted`)
    }
  }

  log('Done.')
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
