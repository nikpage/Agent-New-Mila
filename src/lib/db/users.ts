import { getSupabaseAdmin } from '../supabase/client'
import type { User, UserInsert, UserSettings } from '../supabase/types'
import { DEFAULT_USER_SETTINGS } from '../supabase/types'
import { encryptTokens } from '../crypto'

export interface GoogleTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
  scope: string
  token_type: string
}

/**
 * Get a user by ID
 */
export async function getUserById(userId: string): Promise<User | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return null
    }
    throw new Error(`Failed to get user: ${error.message}`)
  }

  return data
}

/**
 * Get a user by email
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get user by email: ${error.message}`)
  }

  return data
}

/**
 * Get all users with email enabled
 */
export async function getUsersWithEmailEnabled(): Promise<User[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email_enabled', true)
    .eq('email_unsubscribed', false)

  if (error) {
    throw new Error(`Failed to get users: ${error.message}`)
  }

  return data || []
}

/**
 * Create or update a user
 */
export async function upsertUser(user: UserInsert): Promise<User> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('users')
    .upsert(user)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to upsert user: ${error.message}`)
  }

  return data
}

/**
 * Update user's Google OAuth tokens.
 * Dual-writes: plaintext (google_oauth_tokens) + encrypted (encrypted_google_tokens).
 * This allows safe rollback — the plaintext column stays in sync until we remove it.
 */
export async function updateUserGoogleTokens(
  userId: string,
  tokens: GoogleTokens
): Promise<void> {
  const supabase = getSupabaseAdmin()

  const encrypted = encryptTokens(tokens)

  const { error } = await supabase
    .from('users')
    .update({
      google_oauth_tokens: tokens as unknown as Record<string, unknown>,
      encrypted_google_tokens: encrypted,
    })
    .eq('id', userId)

  if (error) {
    throw new Error(`Failed to update Google tokens: ${error.message}`)
  }
}

/**
 * Get user's Google OAuth tokens
 */
export async function getUserGoogleTokens(userId: string): Promise<GoogleTokens | null> {
  const user = await getUserById(userId)
  if (!user?.google_oauth_tokens) return null
  return user.google_oauth_tokens as unknown as GoogleTokens
}

/**
 * Get user settings with defaults applied
 */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const user = await getUserById(userId)
  if (!user?.settings) return { ...DEFAULT_USER_SETTINGS }

  const stored = user.settings as unknown as Partial<UserSettings>
  return {
    ...DEFAULT_USER_SETTINGS,
    ...stored,
  }
}

/**
 * Get users whose brief is due now (within windowMinutes of their configured time).
 * Compares user's configured brief time (in their timezone) to current real time.
 */
export async function getUsersDueBrief(
  briefType: 'morning' | 'afternoon',
  windowMinutes: number = 30
): Promise<User[]> {
  const users = await getUsersWithEmailEnabled()
  const now = new Date()

  return users.filter(user => {
    const settings = user.settings as Record<string, unknown> | null
    const settingKey = briefType === 'morning' ? 'morning_brief_time' : 'afternoon_brief_time'
    const briefTime = (settings?.[settingKey] as string) ||
      (briefType === 'morning' ? '08:00' : '13:00')
    const timezone = (settings?.timezone as string) || 'Europe/Prague'

    // Get current HH:MM in user's timezone using Intl (reliable across Node versions)
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })
    const parts = formatter.formatToParts(now)
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
    const userMinutes = hour * 60 + minute

    const [hours, minutes] = briefTime.split(':').map(Number)
    const briefMinutes = hours * 60 + minutes

    // User is due if their brief time falls within [now, now + window)
    // e.g., cron fires at 7:30, window=30 → catches users with brief_time 7:30-7:59
    const diff = briefMinutes - userMinutes
    return diff >= 0 && diff < windowMinutes
  })
}

/**
 * Update user settings (merges new settings with existing ones)
 */
export async function updateUserSettings(
  userId: string,
  settings: Record<string, unknown>
): Promise<void> {
  const supabase = getSupabaseAdmin()

  // Read current settings so we can merge rather than overwrite
  const user = await getUserById(userId)
  const existing = (user?.settings as Record<string, unknown>) || {}
  const merged = { ...existing, ...settings }

  const { error } = await supabase
    .from('users')
    .update({ settings: merged })
    .eq('id', userId)

  if (error) {
    throw new Error(`Failed to update settings: ${error.message}`)
  }
}
