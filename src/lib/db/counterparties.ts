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
 * Find or create a counterparty by email
 */
export async function findOrCreateCP(
  userId: string,
  email: string,
  name?: string
): Promise<CP> {
  const normalizedEmail = email.toLowerCase().trim()

  // Guard: NEVER create a CP for the user's own email address.
  // FAIL CLOSED: if user has no email in DB, refuse rather than risk creating a self-CP.
  const user = await getUserById(userId)

  if (user?.email) {
    if (user.email.toLowerCase() === normalizedEmail) {
      throw new Error(`[findOrCreateCP] Refusing to create CP for user's own email: ${normalizedEmail}`)
    }
  } else {
    throw new Error(`[findOrCreateCP] User ${userId} has no email in DB — cannot safely verify this is not a self-reference. Aborting CP creation for: ${normalizedEmail}`)
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
