import { getSupabaseAdmin } from '../supabase/client'

export type ChannelType = 'email' | 'whatsapp' | string

/**
 * Find or create a channel record for a user.
 * Returns the channel UUID.
 */
export async function getOrCreateChannel(
  userId: string,
  type: ChannelType,
  identifier: string
): Promise<string> {
  const supabase = getSupabaseAdmin()

  // Try to find existing channel
  const { data: existing } = await supabase
    .from('channels')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type)
    .eq('identifier', identifier)
    .limit(1)
    .single()

  if (existing) return existing.id

  // Create new channel
  const { data: created, error } = await supabase
    .from('channels')
    .insert({ user_id: userId, type, identifier })
    .select('id')
    .single()

  if (error) {
    // Race condition: another process created it between our select and insert
    if (error.code === '23505') {
      const { data: retry } = await supabase
        .from('channels')
        .select('id')
        .eq('user_id', userId)
        .eq('type', type)
        .eq('identifier', identifier)
        .limit(1)
        .single()
      if (retry) return retry.id
    }
    throw new Error(`Failed to create channel (${type}/${identifier}): ${error.message}`)
  }

  return created.id
}

/**
 * Look up channel type from a channel_id UUID.
 * Returns 'email' for null (backward compat — all existing email messages have channel_id: null).
 */
export async function getChannelType(channelId: string | null): Promise<ChannelType> {
  if (!channelId) return 'email'

  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('channels')
    .select('type')
    .eq('id', channelId)
    .limit(1)
    .single()

  return (data?.type as ChannelType) || 'email'
}

/**
 * Batch-resolve channel types for multiple channel_ids.
 * More efficient than calling getChannelType per message.
 * Returns a Map of channelId -> type. Null maps to 'email'.
 */
export async function getChannelTypes(channelIds: (string | null)[]): Promise<Map<string | null, ChannelType>> {
  const result = new Map<string | null, ChannelType>()
  result.set(null, 'email')

  const uniqueIds = [...new Set(channelIds.filter((id): id is string => id !== null))]
  if (uniqueIds.length === 0) return result

  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('channels')
    .select('id, type')
    .in('id', uniqueIds)

  for (const row of data || []) {
    result.set(row.id, row.type as ChannelType)
  }

  // Any UUID not found defaults to 'email'
  for (const id of uniqueIds) {
    if (!result.has(id)) result.set(id, 'email')
  }

  return result
}
