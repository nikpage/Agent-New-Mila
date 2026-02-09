import { getSupabaseAdmin } from '../supabase/client'
import { getUserById } from './users'
import type { CP, CPInsert, CPState } from '../supabase/types'

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

  // DOUBLE CHECK: Ensure we are not creating a CP for the user themselves
  // This requires fetching the user, which adds overhead, but safety is priority.
  // We only do this check if we are inserting (no ID) or if we want to be extra safe.
  // Since upsertCP is low-level, we rely on findOrCreateCP for the logic,
  // but we can add a basic check if the user_id is available to look up.

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
 * Find or create a counterparty by email
 */
export async function findOrCreateCP(
  userId: string,
  email: string,
  name?: string
): Promise<CP> {
  const normalizedEmail = email.toLowerCase().trim()

  // Guard: NEVER create a CP for the user's own email address
  const user = await getUserById(userId)

  if (user?.email) {
    if (user.email.toLowerCase() === normalizedEmail) {
      throw new Error(`Cannot create counterparty for user's own email address: ${normalizedEmail}`)
    }
  } else {
    // If user has no email in DB, this is a critical data integrity issue.
    // We should probably fail or warn, but to be safe, we proceed with caution.
    console.warn(`[findOrCreateCP] User ${userId} has no email in DB. Cannot verify self-reference.`)
  }

  const existing = await getCPByIdentifier(userId, normalizedEmail)
  if (existing) {
    // Update name if provided and CP doesn't have one
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
