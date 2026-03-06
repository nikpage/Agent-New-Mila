import { getSupabaseAdmin } from '../supabase/client'
import { getUserById } from './users'
import type { CP, CPInsert, CPState } from '../supabase/types'

/** Domains where dots in the local part are irrelevant. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/**
 * Normalize an email for deduplication.
 * - Always lowercases and trims.
 * - For Gmail/Googlemail: strips dots from local part (Gmail ignores them).
 * - For all other domains: preserves dots in both parts (they are significant).
 *
 * Use this for DB lookups and Set membership. Use `isSameGmailAddress` for
 * two-value comparison.
 */
export function normalizeGmailAddress(email: string): string {
  const [local, domain] = email.toLowerCase().trim().split('@')
  if (!local || !domain) return email.toLowerCase().trim()
  const normalizedLocal = GMAIL_DOMAINS.has(domain) ? local.replace(/\./g, '') : local
  return `${normalizedLocal}@${domain}`
}

/** True if two emails refer to the same Gmail / Google Workspace mailbox. */
export function isSameGmailAddress(a: string, b: string): boolean {
  return normalizeGmailAddress(a) === normalizeGmailAddress(b)
}

/**
 * Delete any CP row where the identifier matches the user's own email.
 * Also repairs CP emails corrupted by the old normalizer (dot-stripped domains).
 * The user is NOT a counterparty. Full stop.
 * Called at the start of every agent run to clean up bad data.
 */
export async function purgeUserAsCp(userId: string): Promise<number> {
  const user = await getUserById(userId)
  if (!user?.email) return 0

  const supabase = getSupabaseAdmin()

  const { data: allCps, error: fetchError } = await supabase
    .from('cps')
    .select('id, primary_identifier')
    .eq('user_id', userId)

  if (fetchError || !allCps) return 0

  // Repair corrupted emails: old normalizer stripped dots from domains
  // e.g. "jan@gmailcom" → "jan@gmail.com"
  for (const cp of allCps) {
    const repaired = repairDomainDots(cp.primary_identifier)
    if (repaired !== cp.primary_identifier) {
      const { error: repairErr } = await supabase
        .from('cps')
        .update({ primary_identifier: repaired })
        .eq('id', cp.id)
      if (!repairErr) {
        console.log(`[purgeUserAsCp] Repaired CP email: ${cp.primary_identifier} → ${repaired}`)
        cp.primary_identifier = repaired
      }
    }
  }

  // Delete CPs that match the user's own email
  const selfCpIds = allCps
    .filter(cp => isSameGmailAddress(cp.primary_identifier, user.email!))
    .map(cp => cp.id)

  if (selfCpIds.length === 0) return 0

  const { data, error } = await supabase
    .from('cps')
    .delete()
    .in('id', selfCpIds)
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
 * Repair email domains corrupted by the old normalizer that stripped dots
 * from domains (e.g. "gmailcom" → "gmail.com", "yahoocom" → "yahoo.com").
 * Returns the original email if no repair is needed.
 */
function repairDomainDots(email: string): string {
  const atIdx = email.lastIndexOf('@')
  if (atIdx < 0) return email

  const local = email.slice(0, atIdx)
  const domain = email.slice(atIdx + 1)

  // If domain already has a dot, it's fine
  if (domain.includes('.')) return email

  // Known dot-stripped domains → repaired
  const KNOWN_REPAIRS: Record<string, string> = {
    'gmailcom': 'gmail.com',
    'googlemailcom': 'googlemail.com',
    'yahoocom': 'yahoo.com',
    'hotmailcom': 'hotmail.com',
    'outlookcom': 'outlook.com',
    'seznamcz': 'seznam.cz',
    'emailcz': 'email.cz',
    'centrumc': 'centrum.cz',
    'iaborecz': 'iabore.cz',
  }

  const repaired = KNOWN_REPAIRS[domain]
  if (repaired) return `${local}@${repaired}`

  // Generic heuristic: try inserting a dot before common TLDs
  const tldPatterns = [
    { suffix: 'com', tld: '.com' },
    { suffix: 'cz', tld: '.cz' },
    { suffix: 'sk', tld: '.sk' },
    { suffix: 'eu', tld: '.eu' },
    { suffix: 'net', tld: '.net' },
    { suffix: 'org', tld: '.org' },
    { suffix: 'io', tld: '.io' },
    { suffix: 'de', tld: '.de' },
    { suffix: 'co', tld: '.co' },
  ]

  for (const { suffix, tld } of tldPatterns) {
    if (domain.endsWith(suffix) && domain.length > suffix.length) {
      return `${local}@${domain.slice(0, -suffix.length)}${tld}`
    }
  }

  return email
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
 * Get multiple counterparties by IDs in a single query
 */
export async function getCPsByIds(cpIds: string[]): Promise<CP[]> {
  if (cpIds.length === 0) return []
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('cps')
    .select('*')
    .in('id', cpIds)

  if (error) throw new Error(`Failed to get CPs: ${error.message}`)
  return data || []
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
    .eq('primary_identifier', normalizeGmailAddress(identifier))
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

  // Normalize the identifier (Gmail dot/case insensitive)
  const normalizedCP = {
    ...cp,
    primary_identifier: normalizeGmailAddress(cp.primary_identifier),
  }

  // HARD GUARD: Never create a CP for the user's own email.
  const user = await getUserById(cp.user_id)
  if (user?.email && isSameGmailAddress(user.email, normalizedCP.primary_identifier)) {
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
 *
 * Uses upsert-first to avoid the SELECT→INSERT race condition where two
 * concurrent messages from the same unknown sender both see "not found"
 * and both try to insert.
 */
export async function findOrCreateCP(
  userId: string,
  email: string,
  name?: string
): Promise<CP | null> {
  const normalizedEmail = normalizeGmailAddress(email)

  // The user is not a CP. Silent return, no throw, no noise.
  const user = await getUserById(userId)
  if (!user?.email) return null
  if (isSameGmailAddress(user.email, normalizedEmail)) return null

  const supabase = getSupabaseAdmin()

  // Upsert-first: ON CONFLICT (user_id, primary_identifier) DO NOTHING.
  // This is atomic — no race window between SELECT and INSERT.
  const { data: upserted, error: upsertError } = await supabase
    .from('cps')
    .upsert(
      {
        user_id: userId,
        primary_identifier: normalizedEmail,
        name: name || null,
        is_blacklisted: false,
      },
      { onConflict: 'user_id,primary_identifier', ignoreDuplicates: true }
    )
    .select()
    .single()

  // If upsert returned data, we either created or matched. Check name backfill.
  if (!upsertError && upserted) {
    if (name && !upserted.name) {
      return updateCP(upserted.id, { name })
    }
    return upserted
  }

  // ignoreDuplicates may return no rows on conflict. Fetch the existing row.
  const existing = await getCPByIdentifier(userId, normalizedEmail)
  if (existing) {
    if (name && !existing.name) {
      return updateCP(existing.id, { name })
    }
    return existing
  }

  // Should not reach here, but surface the original error if we do
  throw new Error(`Failed to find or create CP for ${normalizedEmail}: ${upsertError?.message || 'unknown error'}`)
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
