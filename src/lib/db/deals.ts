import { getSupabaseAdmin } from '../supabase/client'
import type { Deal, DealInsert } from '../supabase/types'

export async function createDeal(deal: DealInsert): Promise<Deal> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deals')
    .insert({
      ...deal,
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create deal: ${error.message}`)
  return data
}

export async function getDealById(dealId: string): Promise<Deal | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .eq('id', dealId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get deal: ${error.message}`)
  }
  return data
}

export async function getDealsForUser(
  userId: string,
  options?: { status?: string; category?: string; limit?: number }
): Promise<Deal[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('deals')
    .select('*')
    .eq('user_id', userId)
    .order('last_activity_at', { ascending: false, nullsFirst: false })

  if (options?.status) query = query.eq('status', options.status)
  if (options?.category) query = query.eq('category', options.category)
  if (options?.limit) query = query.limit(options.limit)

  const { data, error } = await query
  if (error) throw new Error(`Failed to get deals: ${error.message}`)
  return data || []
}

export async function getActiveDealsForCP(userId: string, cpId: string): Promise<Deal[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deals')
    .select('*, deal_participants!inner(cp_id, status)')
    .eq('user_id', userId)
    .eq('status', 'active')
    .eq('deal_participants.cp_id', cpId)
    .eq('deal_participants.status', 'active')

  if (error) throw new Error(`Failed to get active deals for CP: ${error.message}`)
  return (data || []) as Deal[]
}

/**
 * Find a deal by external Gmail/WhatsApp thread ID.
 * Walks: messages.external_thread_id → deal_timeline.message_id → deal_timeline.deal_id
 */
export async function findDealByExternalThread(
  userId: string,
  externalThreadId: string
): Promise<Deal | null> {
  const supabase = getSupabaseAdmin()

  const { data: message } = await supabase
    .from('messages')
    .select('id')
    .eq('user_id', userId)
    .eq('external_thread_id', externalThreadId)
    .not('conversation_id', 'is', null)
    .limit(1)
    .maybeSingle()

  if (!message) return null

  const { data: entry } = await supabase
    .from('deal_timeline')
    .select('deal_id')
    .eq('message_id', message.id)
    .not('deal_id', 'is', null)
    .limit(1)
    .maybeSingle()

  if (!entry?.deal_id) return null
  return getDealById(entry.deal_id)
}

export async function updateDeal(
  dealId: string,
  updates: Partial<Omit<Deal, 'id' | 'user_id' | 'created_at'>>
): Promise<Deal> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deals')
    .update(updates)
    .eq('id', dealId)
    .select()
    .single()

  if (error) throw new Error(`Failed to update deal: ${error.message}`)
  return data
}

export async function archiveDeal(dealId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('deals')
    .update({ status: 'archived' })
    .eq('id', dealId)

  if (error) throw new Error(`Failed to archive deal: ${error.message}`)
}
