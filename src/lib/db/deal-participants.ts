import { getSupabaseAdmin } from '../supabase/client'
import type { Deal, DealParticipant, DealParticipantInsert } from '../supabase/types'

export async function addDealParticipant(
  dealId: string,
  cpId: string,
  role?: string
): Promise<DealParticipant> {
  const supabase = getSupabaseAdmin()

  // idx_deal_participants_unique is PARTIAL (WHERE status = 'active') so
  // supabase-js upsert cannot target it via onConflict. Do an explicit
  // check-then-insert, with a 23505 fallback for the concurrent-insert race.
  const matchExisting = () => {
    let q = supabase
      .from('deal_participants')
      .select('*')
      .eq('deal_id', dealId)
      .eq('cp_id', cpId)
      .eq('status', 'active')
    q = role == null ? q.is('role', null) : q.eq('role', role)
    return q.maybeSingle()
  }

  const { data: existing, error: selectErr } = await matchExisting()
  if (selectErr) throw new Error(`Failed to check deal participant: ${selectErr.message}`)
  if (existing) return existing

  const { data, error } = await supabase
    .from('deal_participants')
    .insert({
      deal_id: dealId,
      cp_id: cpId,
      role: role ?? null,
      status: 'active',
      added_at: new Date().toISOString(),
    } satisfies DealParticipantInsert)
    .select()
    .single()

  if (!error) return data

  if (error.code === '23505') {
    const { data: raced, error: racedErr } = await matchExisting()
    if (racedErr) throw new Error(`Failed to re-select after conflict: ${racedErr.message}`)
    if (raced) return raced
  }
  throw new Error(`Failed to add deal participant: ${error.message}`)
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
