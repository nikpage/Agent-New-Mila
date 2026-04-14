import { getSupabaseAdmin } from '../supabase/client'
import type { EntityMapEntry, EntityMapEntryInsert } from '../supabase/types'

export async function upsertEntity(
  userId: string,
  dealId: string,
  entityType: string,
  entityKey: string,
  entityValue: string,
  sourceMessageId: string | null,
  confidence: number = 1.0
): Promise<EntityMapEntry> {
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('entity_map')
    .upsert(
      {
        user_id: userId,
        deal_id: dealId,
        entity_type: entityType,
        entity_key: entityKey,
        entity_value: entityValue,
        source_message_id: sourceMessageId,
        confidence,
        updated_at: now,
      } satisfies EntityMapEntryInsert,
      { onConflict: 'deal_id,entity_type,entity_key' }
    )
    .select()
    .single()

  if (error) throw new Error(`Failed to upsert entity: ${error.message}`)
  return data
}

export async function getEntitiesForDeal(
  dealId: string,
  entityType?: string
): Promise<EntityMapEntry[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('entity_map')
    .select('*')
    .eq('deal_id', dealId)

  if (entityType) query = query.eq('entity_type', entityType)

  const { data, error } = await query
  if (error) throw new Error(`Failed to get entities: ${error.message}`)
  return data || []
}

export async function getEntity(
  dealId: string,
  entityType: string,
  entityKey: string
): Promise<EntityMapEntry | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('entity_map')
    .select('*')
    .eq('deal_id', dealId)
    .eq('entity_type', entityType)
    .eq('entity_key', entityKey)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get entity: ${error.message}`)
  }
  return data
}

export async function deleteEntity(
  dealId: string,
  entityType: string,
  entityKey: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('entity_map')
    .delete()
    .eq('deal_id', dealId)
    .eq('entity_type', entityType)
    .eq('entity_key', entityKey)

  if (error) throw new Error(`Failed to delete entity: ${error.message}`)
}
