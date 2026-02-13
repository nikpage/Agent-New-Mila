import { getSupabaseAdmin } from '../supabase/client'
import { getUserById } from './users'
import type { CP, CPInsert, CPState } from '../supabase/types'

/**
 * Delete any CP row where the identifier matches the user's own email.
 * The user is NOT a counterparty. Full stop.
 * Called at the start of every agent run to clean up bad data.
 */
export async function purgeUserAsCp(userId: string): Promise<number> {
  const user = await getUserById(userId)
  if (!user?.email) return 0

  const supabase = getSupabaseAdmin()
  const userEmailLower = user.email.toLowerCase()

  const { data, error } = await supabase
    .from('cps')
    .delete()
    .eq('user_id', userId)
    .eq('primary_identifier', userEmailLower)
    .select('id')

  if (error) {
    console.error(`[purgeUserAsCp] Failed to purge: ${error.message}`)
    return 0
  }

  if (data && data.length > 0) {
    console.warn(`[purgeUserAsCp] Deleted ${data.length} self-CP rows for user ${userId}`)
  }

  return data?.length || 0
}

/**
 * Get a counterparty by ID
 */
export async function getCPById(cpId: string): Promise<CP | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('cps')
    .select('*')
    .eq('id', cpId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get CP: ${error.message}`)
  }

  return data
}

/**
 * Get a counterparty by primary identifier (email)
 */
export async function getCPByIdentifier(
  userId: string,
  identifier: string
): Promise<CP | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('cps')
    .select('*')
    .eq('user_id', userId)
    .eq('primary_identifier', identifier.toLowerCase())
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get CP by identifier: ${error.message}`)
  }

  return data
}

/**
 * Get all counterparties for a user
 */
export async function getCPsForUser(userId: string): Promise<CP[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('cps')
    .select('*')
    .eq('user_id', userId)
    .eq('is_blacklisted', false)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to get CPs: ${error.message}`)
  }

  return data || []
}

/**
 * Create or update a counterparty
 */
export async function upsertCP(cp: CPInsert): Promise<CP> {
  const supabase = getSupabaseAdmin()

  // Normalize the identifier
  const normalizedCP = {
    ...cp,
    primary_identifier: cp.primary_identifier.toLowerCase(),
  }

  // HARD GUARD: Never create a CP for the user's own email.
  // This is the lowest-level chokepoint — every CP creation goes through here.
  const user = await getUserById(cp.user_id)
  if (user?.email && user.email.toLowerCase() === normalizedCP.primary_identifier) {
    throw new Error(`[upsertCP] Refusing to create CP for user's own email: ${normalizedCP.primary_identifier}`)
  }

  const { data, error } = await supabase
    .from('cps')
    .upsert(normalizedCP, {
      onConflict: 'user_id,primary_identifier',
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to upsert CP: ${error.message}`)
  }

  return data
}

/**
 * Find or create a counterparty by email.
 * Returns null if the email belongs to the user — the user is NOT a CP.
 */
export async function findOrCreateCP(
  userId: string,
  email: string,
  name?: string
): Promise<CP | null> {
  const normalizedEmail = email.toLowerCase().trim()

  // The user is not a CP. Silent return, no throw, no noise.
  const user = await getUserById(userId)
  if (!user?.email) return null
  if (user.email.toLowerCase() === normalizedEmail) return null

  const existing = await getCPByIdentifier(userId, normalizedEmail)
  if (existing) {
    if (name && !existing.name) {
      return updateCP(existing.id, { name })
    }
    return existing
  }

  return upsertCP({
    user_id: userId,
    primary_identifier: normalizedEmail,
    name: name || null,
    is_blacklisted: false,
  })
}

/**
 * Update a counterparty
 */
export async function updateCP(
  cpId: string,
  updates: Partial<Omit<CP, 'id' | 'user_id' | 'created_at'>>
): Promise<CP> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('cps')
    .update(updates)
    .eq('id', cpId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update CP: ${error.message}`)
  }

  return data
}

/**
 * Blacklist a counterparty
 */
export async function blacklistCP(cpId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('cps')
    .update({ is_blacklisted: true })
    .eq('id', cpId)

  if (error) {
    throw new Error(`Failed to blacklist CP: ${error.message}`)
  }
}

/**
 * Get CP state
 */
export async function getCPState(cpId: string): Promise<CPState | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('cp_states')
    .select('*')
    .eq('cp_id', cpId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get CP state: ${error.message}`)
  }

  return data
}

/**
 * Update CP state
 */
export async function updateCPState(
  cpId: string,
  state: string,
  summaryText?: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('cp_states')
    .upsert({
      cp_id: cpId,
      state,
      summary_text: summaryText || null,
      last_updated: new Date().toISOString(),
    })

  if (error) {
    throw new Error(`Failed to update CP state: ${error.message}`)
  }
}
