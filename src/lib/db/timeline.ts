import { getSupabaseAdmin } from '../supabase/client'
import type { DealTimelineEntry, DealTimelineInsert } from '../supabase/types'

/**
 * Insert a timeline entry. Returns the created entry.
 * Silently skips if message_id already exists (unique index).
 */
export async function createTimelineEntry(entry: DealTimelineInsert): Promise<DealTimelineEntry | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_timeline')
    .insert(entry)
    .select()
    .single()

  if (error) {
    // Unique constraint on message_id — already inserted, skip
    if (error.code === '23505') return null
    throw new Error(`Failed to create timeline entry: ${error.message}`)
  }

  return data
}

/**
 * Get all unassigned timeline entries for a user (conversation_id IS NULL).
 * Ordered by occurred_at ascending — process oldest first.
 */
export async function getUnassignedTimelineEntries(
  userId: string,
  limit: number = 100
): Promise<DealTimelineEntry[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_timeline')
    .select('*')
    .eq('user_id', userId)
    .is('conversation_id', null)
    .order('occurred_at', { ascending: true })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get unassigned timeline entries: ${error.message}`)
  }

  return data || []
}

/**
 * Write conversation_id back to a timeline entry after assignment.
 */
export async function assignTimelineEntry(
  entryId: string,
  conversationId: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('deal_timeline')
    .update({ conversation_id: conversationId })
    .eq('id', entryId)

  if (error) {
    throw new Error(`Failed to assign timeline entry: ${error.message}`)
  }
}

/**
 * Get recent timeline entries for a conversation, ordered by occurred_at.
 * Used for context in action proposals, summary rebuilds, and draft writing.
 */
export async function getTimelineForConversation(
  conversationId: string,
  limit: number = 20
): Promise<DealTimelineEntry[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_timeline')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get timeline for conversation: ${error.message}`)
  }

  // Return in chronological order
  return (data || []).reverse()
}

/**
 * Get recent timeline entries for a specific CP across all conversations.
 * Used for conversation assignment — provides context when deciding
 * which conversation a new event belongs to.
 */
export async function getTimelineForCP(
  userId: string,
  cpId: string,
  limit: number = 20
): Promise<DealTimelineEntry[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_timeline')
    .select('*')
    .eq('user_id', userId)
    .eq('cp_id', cpId)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get timeline for CP: ${error.message}`)
  }

  return (data || []).reverse()
}

/**
 * Get the latest inbound timeline entry from a CP.
 * Replaces getLatestMessageFromCP for daysIgnored calculation —
 * now includes phone calls and voice notes, not just email/WA messages.
 */
export async function getLatestInboundFromCP(
  userId: string,
  cpId: string
): Promise<DealTimelineEntry | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('deal_timeline')
    .select('*')
    .eq('user_id', userId)
    .eq('cp_id', cpId)
    .eq('direction', 'in')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get latest inbound from CP: ${error.message}`)
  }

  return data
}

/**
 * Count recent timeline entries per conversation for a CP.
 * Used by the density/recency heuristic in conversation assignment.
 * Returns a Map of conversationId → count of entries in the time window.
 */
export async function getRecentDensityByConversation(
  userId: string,
  cpId: string,
  conversationIds: string[],
  windowMinutes: number = 15
): Promise<Map<string, number>> {
  if (conversationIds.length === 0) return new Map()

  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('deal_timeline')
    .select('conversation_id')
    .eq('user_id', userId)
    .eq('cp_id', cpId)
    .in('conversation_id', conversationIds)
    .gte('occurred_at', since)

  if (error) {
    throw new Error(`Failed to get density: ${error.message}`)
  }

  const counts = new Map<string, number>()
  for (const row of data || []) {
    if (row.conversation_id) {
      counts.set(row.conversation_id, (counts.get(row.conversation_id) || 0) + 1)
    }
  }
  return counts
}

/**
 * Get recent timeline entries for specific conversations (for AI assignment context).
 * Returns entries grouped by conversation_id.
 */
export async function getTimelineContextForConversations(
  conversationIds: string[],
  limitPerConversation: number = 10
): Promise<Map<string, DealTimelineEntry[]>> {
  if (conversationIds.length === 0) return new Map()

  const supabase = getSupabaseAdmin()

  // Fetch recent entries for all candidate conversations in one query
  // Over-fetch and trim per-conversation in code
  const { data, error } = await supabase
    .from('deal_timeline')
    .select('*')
    .in('conversation_id', conversationIds)
    .order('occurred_at', { ascending: false })
    .limit(limitPerConversation * conversationIds.length)

  if (error) {
    throw new Error(`Failed to get timeline context: ${error.message}`)
  }

  const grouped = new Map<string, DealTimelineEntry[]>()
  for (const entry of data || []) {
    if (!entry.conversation_id) continue
    const list = grouped.get(entry.conversation_id) || []
    if (list.length < limitPerConversation) {
      list.push(entry)
    }
    grouped.set(entry.conversation_id, list)
  }

  // Reverse each group to chronological order
  for (const key of Array.from(grouped.keys())) {
    grouped.set(key, grouped.get(key)!.reverse())
  }

  return grouped
}

/**
 * Find orphan call logs — calls with no voice note attached.
 * Used to flag "a call happened but no notes were recorded."
 */
export async function getOrphanCallLogs(
  userId: string,
  hoursBack: number = 24
): Promise<DealTimelineEntry[]> {
  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

  // Get all call logs in the time window
  const { data: callLogs, error: callErr } = await supabase
    .from('deal_timeline')
    .select('*')
    .eq('user_id', userId)
    .eq('event_type', 'call_log')
    .not('conversation_id', 'is', null)
    .gte('occurred_at', since)

  if (callErr || !callLogs) return []

  if (callLogs.length === 0) return []

  // Get all voice notes that are children of these call logs
  const callLogIds = callLogs.map(c => c.id)
  const { data: voiceNotes } = await supabase
    .from('deal_timeline')
    .select('parent_id')
    .eq('event_type', 'voice_note')
    .in('parent_id', callLogIds)

  const hasNote = new Set((voiceNotes || []).map(v => v.parent_id))
  return callLogs.filter(c => !hasNote.has(c.id))
}

/**
 * Get conversations where the CP has gone silent (no inbound activity for N+ days).
 * Used for the "Chladnoucí kontakty" section in the web brief.
 */
export async function getCoolingConversations(
  userId: string,
  minDaysSilent: number = 5,
  limit: number = 5
): Promise<{ conversationId: string; cpName: string; topic: string | null; daysSilent: number }[]> {
  const supabase = getSupabaseAdmin()

  // Get active conversations for this user
  const { data: conversations, error: convErr } = await supabase
    .from('conversation_threads')
    .select('id, topic')
    .eq('user_id', userId)
    .eq('status', 'active')

  if (convErr || !conversations?.length) return []

  // Get latest inbound timeline entry per conversation in a single query
  const convIds = conversations.map(c => c.id)
  const { data: latestEntries, error: tlErr } = await supabase
    .from('deal_timeline')
    .select('conversation_id, occurred_at')
    .eq('user_id', userId)
    .eq('direction', 'in')
    .in('conversation_id', convIds)
    .order('occurred_at', { ascending: false })

  if (tlErr) return []

  // Find latest inbound per conversation
  const latestByConv = new Map<string, string>()
  for (const entry of latestEntries || []) {
    if (!entry.conversation_id) continue
    if (!latestByConv.has(entry.conversation_id)) {
      latestByConv.set(entry.conversation_id, entry.occurred_at)
    }
  }

  const cutoffMs = minDaysSilent * 24 * 60 * 60 * 1000
  const now = Date.now()
  const cooling: { conversationId: string; topic: string | null; daysSilent: number }[] = []

  for (const conv of conversations) {
    const lastInbound = latestByConv.get(conv.id)
    if (!lastInbound) continue // No inbound ever — skip (probably a new conversation)
    const elapsed = now - new Date(lastInbound).getTime()
    if (elapsed >= cutoffMs) {
      cooling.push({
        conversationId: conv.id,
        topic: conv.topic,
        daysSilent: Math.floor(elapsed / (24 * 60 * 60 * 1000)),
      })
    }
  }

  // Sort by most silent first, limit
  cooling.sort((a, b) => b.daysSilent - a.daysSilent)
  const topCooling = cooling.slice(0, limit)

  if (topCooling.length === 0) return []

  // Fetch CP names for these conversations via thread_participants
  const coolingConvIds = topCooling.map(c => c.conversationId)
  const { data: participants } = await supabase
    .from('thread_participants')
    .select('thread_id, cp_id')
    .in('thread_id', coolingConvIds)

  if (!participants?.length) {
    return topCooling.map(c => ({ ...c, cpName: 'Neznámý' }))
  }

  // Get unique CP IDs
  const cpIdByConv = new Map<string, string>()
  for (const p of participants) {
    if (!cpIdByConv.has(p.thread_id)) {
      cpIdByConv.set(p.thread_id, p.cp_id)
    }
  }

  const uniqueCpIds = [...new Set(cpIdByConv.values())]
  const { data: cps } = await supabase
    .from('cps')
    .select('id, name, primary_identifier')
    .in('id', uniqueCpIds)

  const cpNameMap = new Map<string, string>()
  for (const cp of cps || []) {
    cpNameMap.set(cp.id, cp.name || cp.primary_identifier || 'Neznámý')
  }

  return topCooling.map(c => {
    const cpId = cpIdByConv.get(c.conversationId)
    return {
      ...c,
      cpName: cpId ? cpNameMap.get(cpId) || 'Neznámý' : 'Neznámý',
    }
  })
}
