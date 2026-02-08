import { getSupabaseAdmin } from '../supabase/client'
import type { User, UserInsert, UserSettings } from '../supabase/types'
import { DEFAULT_USER_SETTINGS } from '../supabase/types'

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
  console.log('[getUserById] Looking up user:', userId)
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single()

  console.log('[getUserById] Query result - data:', !!data, 'error:', error?.code, error?.message)

  if (error) {
    if (error.code === 'PGRST116') {
      console.log('[getUserById] User not found in database')
      return null
    }
    throw new Error(`Failed to get user: ${error.message}`)
  }

  console.log('[getUserById] Found user:', data?.id, data?.email)
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
 * Update user's Google OAuth tokens
 */
export async function updateUserGoogleTokens(
  userId: string,
  tokens: GoogleTokens
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('users')
    .update({ google_oauth_tokens: tokens as unknown as Record<string, unknown> })
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
 * Update user settings
 */
export async function updateUserSettings(
  userId: string,
  settings: Record<string, unknown>
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('users')
    .update({ settings })
    .eq('id', userId)

  if (error) {
    throw new Error(`Failed to update settings: ${error.message}`)
  }
}
