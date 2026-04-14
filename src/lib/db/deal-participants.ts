import { getSupabaseAdmin } from '../supabase/client'
import type { Deal, DealParticipant, DealParticipantInsert } from '../supabase/types'

export async function addDealParticipant(
  dealId: string,
  cpId: string,
  role?: string
): Promise<DealParticipant> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_participants')
    .upsert(
      {
        deal_id: dealId,
        cp_id: cpId,
        role: role ?? null,
        status: 'active',
        added_at: new Date().toISOString(),
      } satisfies DealParticipantInsert,
      { onConflict: 'deal_id,cp_id,role' }
    )
    .select()
    .single()

  if (error) throw new Error(`Failed to add deal participant: ${error.message}`)
  return data
}

export async function getParticipantsForDeal(dealId: string): Promise<DealParticipant[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_participants')
    .select('*')
    .eq('deal_id', dealId)
    .eq('status', 'active')

  if (error) throw new Error(`Failed to get deal participants: ${error.message}`)
  return data || []
}

export async function dropDealParticipant(dealId: string, cpId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('deal_participants')
    .update({ status: 'dropped', dropped_at: new Date().toISOString() })
    .eq('deal_id', dealId)
    .eq('cp_id', cpId)
    .eq('status', 'active')

  if (error) throw new Error(`Failed to drop deal participant: ${error.message}`)
}

/**
 * Find all active deals a CP is participating in for a given user.
 */
export async function findDealsForCP(userId: string, cpId: string): Promise<Deal[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deals')
    .select('*, deal_participants!inner(cp_id, status)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .eq('deal_participants.cp_id', cpId)
    .eq('deal_participants.status', 'active')

  if (error) throw new Error(`Failed to find deals for CP: ${error.message}`)
  return (data || []) as Deal[]
}
