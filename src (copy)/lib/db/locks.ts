/**
 * DB-based concurrency locks for the agent pipeline.
 *
 * Replaces the in-memory `runningUsers` Map which only worked within a single
 * Vercel serverless instance. This table-based approach works across all
 * instances because it uses the shared Postgres database.
 *
 * Requires migration:
 *
 *   CREATE TABLE user_agent_locks (
 *     user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 *     locked_at timestamptz NOT NULL DEFAULT now(),
 *     expires_at timestamptz NOT NULL
 *   );
 */

import { getSupabaseAdmin } from '../supabase/client'

/** Lock lifetime — auto-expires after this to prevent deadlocks from crashed instances. */
const LOCK_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Try to acquire an exclusive agent-pipeline lock for a user.
 *
 * 1. Cleans up any expired lock for this user.
 * 2. Attempts an INSERT — if the row already exists (another instance holds it),
 *    the unique constraint rejects the insert and we return false.
 *
 * Returns true if the lock was acquired, false if another run is in progress.
 */
export async function tryAcquireUserLock(userId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString()

  // Clean up expired lock for this user (stale from a crashed instance)
  await supabase
    .from('user_agent_locks')
    .delete()
    .eq('user_id', userId)
    .lt('expires_at', now)

  // Try to insert a new lock row
  const { error } = await supabase
    .from('user_agent_locks')
    .insert({ user_id: userId, locked_at: now, expires_at: expiresAt })

  if (error) {
    // Unique constraint violation (23505) = lock already held
    // Any other error = treat as lock failure for safety
    return false
  }

  return true
}

/**
 * Release the agent-pipeline lock for a user.
 * Safe to call even if the lock doesn't exist (idempotent).
 */
export async function releaseUserLock(userId: string): Promise<void> {
  const supabase = getSupabaseAdmin()
  await supabase
    .from('user_agent_locks')
    .delete()
    .eq('user_id', userId)
}
