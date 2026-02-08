import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Using any for now to avoid complex generic issues with Supabase v2
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, 'public', any>

let supabaseAdmin: AnySupabaseClient | null = null
let supabaseAnon: AnySupabaseClient | null = null

/**
 * Get Supabase client with service role key (admin access)
 * Use for server-side operations that bypass RLS
 */
export function getSupabaseAdmin(): AnySupabaseClient {
  if (!supabaseAdmin) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY

    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
    }

    supabaseAdmin = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
  return supabaseAdmin
}

/**
 * Get Supabase client with anon key (respects RLS)
 * Use for client-side or user-scoped operations
 */
export function getSupabaseAnon(): AnySupabaseClient {
  if (!supabaseAnon) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_KEY

    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_KEY')
    }

    supabaseAnon = createClient(url, key)
  }
  return supabaseAnon
}

/**
 * Create a Supabase client with a user's access token
 * Use for operations that should respect RLS as that user
 */
export function getSupabaseWithAuth(accessToken: string): AnySupabaseClient {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_KEY

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_KEY')
  }

  return createClient(url, key, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  })
}
