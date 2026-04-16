#!/usr/bin/env npx tsx
/**
 * One-time cleanup: dismiss all stale pending action_proposals.
 * Usage: npx tsx scripts/clear-stale-cards.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

async function main() {
  const userId = '9e59bc06-7276-453d-bc2e-f224a0a327e3'
  const { data, error } = await supabase
    .from('action_proposals')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id')

  if (error) {
    console.error('Failed:', error.message)
    process.exit(1)
  }
  console.log(`Dismissed ${data?.length ?? 0} stale pending cards`)
}

main()
