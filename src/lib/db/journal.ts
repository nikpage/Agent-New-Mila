import { getSupabaseAdmin } from '../supabase/client'
import type { JournalEntry, JournalEntryInsert } from '../supabase/types'

/**
 * Get active (non-stale) journal entries for a user.
 * Ordered by weight desc, updated_at desc.
 */
export async function getActiveJournalEntries(
  userId: string,
  opts?: {
    scope?: string
    scopeRef?: string
    types?: string[]
    limit?: number
  }
): Promise<JournalEntry[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('journal_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('is_stale', false)

  if (opts?.scope) {
    query = query.eq('scope', opts.scope)
  }
  if (opts?.scopeRef) {
    query = query.eq('scope_ref', opts.scopeRef)
  }
  if (opts?.types) {
    query = query.in('type', opts.types)
  }

  query = query
    .order('weight', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(opts?.limit ?? 50)

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get active journal entries: ${error.message}`)
  }

  return data ?? []
}

/**
 * Get journal entries relevant to specific conversations and their CPs.
 * Returns: global + matching conversation_id + matching cp_id scoped entries.
 */
export async function getJournalEntriesForContext(
  userId: string,
  conversationIds: string[],
  cpIds: string[]
): Promise<JournalEntry[]> {
  const supabase = getSupabaseAdmin()

  const scopeRefList = [...conversationIds, ...cpIds]
  const orFilter = [
    'scope.eq.global',
    ...(scopeRefList.length > 0
      ? [`and(scope.in.(conversation_id,cp_id),scope_ref.in.(${scopeRefList.join(',')}))`]
      : []),
  ].join(',')

  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('is_stale', false)
    .or(orFilter)
    .order('weight', { ascending: false })
    .limit(100)

  if (error) {
    throw new Error(`Failed to get journal entries for context: ${error.message}`)
  }

  return data ?? []
}

/**
 * Get recent journal entries (last N days). For reflection context.
 */
export async function getRecentJournalEntries(
  userId: string,
  sinceDays: number = 7
): Promise<JournalEntry[]> {
  const supabase = getSupabaseAdmin()
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('is_stale', false)
    .gte('created_at', since)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to get recent journal entries: ${error.message}`)
  }

  return data ?? []
}

/**
 * Get all non-stale beliefs for a user. For belief email / audit.
 */
export async function getAllBeliefs(userId: string): Promise<JournalEntry[]> {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('is_stale', false)
    .eq('type', 'belief')
    .order('weight', { ascending: false })

  if (error) {
    throw new Error(`Failed to get beliefs: ${error.message}`)
  }

  return data ?? []
}

/**
 * Create a new journal entry.
 */
export async function createJournalEntry(entry: JournalEntryInsert): Promise<JournalEntry> {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('journal_entries')
    .insert({
      ...entry,
      type: entry.type || 'observation',
      weight: entry.weight ?? 0.1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create journal entry: ${error.message}`)
  }

  return data
}

/**
 * Increment confirm_count + update recency. Promote to belief if count >= 3.
 */
export async function confirmObservation(entryId: string): Promise<JournalEntry> {
  const supabase = getSupabaseAdmin()

  // Read current state
  const { data: current, error: getError } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('id', entryId)
    .single()

  if (getError || !current) {
    throw new Error(`Failed to get journal entry for confirm: ${getError?.message ?? 'not found'}`)
  }

  const newCount = current.confirm_count + 1
  const newType = newCount >= 3 ? 'belief' : current.type
  const recencyFactor = 1.0 // fresh confirmation = full recency
  const newWeight = newType === 'belief'
    ? Math.min(newCount, 25) * recencyFactor
    : newCount * 0.1

  const { data, error } = await supabase
    .from('journal_entries')
    .update({
      confirm_count: newCount,
      type: newType,
      weight: newWeight,
      recency_score: recencyFactor,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to confirm observation: ${error.message}`)
  }

  return data
}

/**
 * Increment conflict_count. Flag volatile if count >= 3.
 */
export async function recordConflict(entryId: string): Promise<JournalEntry> {
  const supabase = getSupabaseAdmin()

  const { data: current, error: getError } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('id', entryId)
    .single()

  if (getError || !current) {
    throw new Error(`Failed to get journal entry for conflict: ${getError?.message ?? 'not found'}`)
  }

  const newConflictCount = current.conflict_count + 1
  const newType = newConflictCount >= 3 ? 'volatile' : current.type

  const { data, error } = await supabase
    .from('journal_entries')
    .update({
      conflict_count: newConflictCount,
      type: newType,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to record conflict: ${error.message}`)
  }

  return data
}

/**
 * Find matching entry by user_id + scope + scope_ref + topic.
 */
export async function findMatchingEntry(
  userId: string,
  scope: string,
  scopeRef: string | null,
  topic: string
): Promise<JournalEntry | null> {
  const supabase = getSupabaseAdmin()

  let query = supabase
    .from('journal_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('scope', scope)
    .eq('topic', topic)
    .eq('is_stale', false)

  if (scopeRef === null) {
    query = query.is('scope_ref', null)
  } else {
    query = query.eq('scope_ref', scopeRef)
  }

  const { data, error } = await query.maybeSingle()

  if (error) {
    throw new Error(`Failed to find matching journal entry: ${error.message}`)
  }

  return data
}

/**
 * Replace belief content. Optionally reset counts (used by contradiction analysis).
 */
export async function replaceBeliefContent(
  entryId: string,
  newContent: string,
  resetCounts: boolean = false
): Promise<void> {
  const supabase = getSupabaseAdmin()

  const updates: Record<string, unknown> = {
    content: newContent,
    updated_at: new Date().toISOString(),
  }

  if (resetCounts) {
    updates.confirm_count = 1
    updates.conflict_count = 0
  }

  const { error } = await supabase
    .from('journal_entries')
    .update(updates)
    .eq('id', entryId)

  if (error) {
    throw new Error(`Failed to replace belief content: ${error.message}`)
  }
}

/**
 * Mark entries stale by conversation scope_ref (called when conversation archived).
 */
export async function markStaleByConversation(conversationId: string): Promise<void> {
  const supabase = getSupabaseAdmin()

  const { error } = await supabase
    .from('journal_entries')
    .update({ is_stale: true, updated_at: new Date().toISOString() })
    .eq('scope', 'conversation_id')
    .eq('scope_ref', conversationId)

  if (error) {
    throw new Error(`Failed to mark journal entries stale: ${error.message}`)
  }
}

/**
 * Mark expired temporal entries as stale. Returns count of expired entries.
 */
export async function expireTemporalEntries(): Promise<number> {
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('journal_entries')
    .update({ is_stale: true, updated_at: now })
    .eq('scope', 'temporal')
    .eq('is_stale', false)
    .lte('expires_at', now)
    .select('id')

  if (error) {
    throw new Error(`Failed to expire temporal entries: ${error.message}`)
  }

  return data?.length ?? 0
}

/**
 * Delete a journal entry (user action via belief email).
 */
export async function deleteJournalEntry(entryId: string): Promise<void> {
  const supabase = getSupabaseAdmin()

  const { error } = await supabase
    .from('journal_entries')
    .delete()
    .eq('id', entryId)

  if (error) {
    throw new Error(`Failed to delete journal entry: ${error.message}`)
  }
}

/**
 * Get current best-guess beliefs for a deal.
 * Returns the latest non-stale entry per topic, ordered by weight desc.
 * This is the "current view" used by the graph walker and card generator.
 */
export async function getCurrentBeliefs(dealId: string): Promise<JournalEntry[]> {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('deal_id', dealId)
    .eq('is_stale', false)
    .order('weight', { ascending: false })
    .order('updated_at', { ascending: false })

  if (error) throw new Error(`Failed to get current beliefs: ${error.message}`)

  // Deduplicate by topic — keep highest-weight entry per topic
  const seen = new Set<string>()
  const result: JournalEntry[] = []
  for (const entry of data ?? []) {
    if (!seen.has(entry.topic)) {
      seen.add(entry.topic)
      result.push(entry)
    }
  }
  return result
}

/**
 * Bulk insert journal entries (onboarding seed).
 */
export async function createJournalEntries(entries: JournalEntryInsert[]): Promise<JournalEntry[]> {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('journal_entries')
    .insert(entries)
    .select()

  if (error) {
    throw new Error(`Failed to bulk create journal entries: ${error.message}`)
  }

  return data ?? []
}
