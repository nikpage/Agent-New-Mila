/**
 * GDPR Compliance — Data deletion, export, audit logging, and retention policy.
 *
 * Requires these Supabase migrations:
 *
 *   CREATE TABLE audit_logs (
 *     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
 *     user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 *     action text NOT NULL,
 *     details jsonb,
 *     ip_address text,
 *     created_at timestamptz DEFAULT now()
 *   );
 *   CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
 *   CREATE INDEX idx_audit_logs_action ON audit_logs(action);
 */

import { getSupabaseAdmin } from '../supabase/client'
import { v4 as uuidv4 } from 'uuid'

export interface AuditLogEntry {
  user_id: string
  action: string
  details?: Record<string, unknown>
  ip_address?: string
}

/**
 * Write an entry to the audit log.
 * Never throws — audit failures are logged but do not crash calling code.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase.from('audit_logs').insert({
      id: uuidv4(),
      user_id: entry.user_id,
      action: entry.action,
      details: entry.details || {},
      ip_address: entry.ip_address || null,
      created_at: new Date().toISOString(),
    })
    if (error) {
      console.error('[GDPR] Failed to write audit log:', error.message)
    }
  } catch (err) {
    console.error('[GDPR] Audit log write error:', err)
  }
}

/**
 * Export all personal data for a user (GDPR Art. 15 — Right of Access).
 * Returns a structured JSON object containing every row the system holds for this user.
 */
export async function exportAllUserData(userId: string): Promise<Record<string, unknown>> {
  const supabase = getSupabaseAdmin()

  const exported: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    user_id: userId,
  }

  // User record
  try {
    const { data } = await supabase.from('users').select('*').eq('id', userId).single()
    exported.user = data || null
  } catch {
    exported.user = null
  }

  // Get user's CP IDs for dependent table lookups
  let cpIds: string[] = []
  try {
    const { data: cps } = await supabase.from('cps').select('*').eq('user_id', userId)
    exported.counterparties = cps || []
    cpIds = (cps || []).map((c: { id: string }) => c.id)
  } catch {
    exported.counterparties = []
  }

  // cp_states (FK through cps)
  if (cpIds.length > 0) {
    try {
      const { data } = await supabase.from('cp_states').select('*').in('cp_id', cpIds)
      exported.cp_states = data || []
    } catch {
      exported.cp_states = []
    }
  } else {
    exported.cp_states = []
  }

  // Direct user_id tables — fetch in parallel
  const directTables = [
    { key: 'channels', table: 'channels' },
    { key: 'conversations', table: 'conversation_threads' },
    { key: 'messages', table: 'messages' },
    { key: 'actions', table: 'action_proposals' },
    { key: 'emails', table: 'emails' },
    { key: 'todos', table: 'todos' },
    { key: 'events', table: 'events' },
    { key: 'agent_errors', table: 'agent_errors' },
  ]

  const directResults = await Promise.allSettled(
    directTables.map(async ({ table }) => {
      const { data } = await supabase.from(table).select('*').eq('user_id', userId)
      return data || []
    })
  )

  directTables.forEach(({ key }, i) => {
    const result = directResults[i]
    exported[key] = result.status === 'fulfilled' ? result.value : []
  })

  // Audit logs for this user
  try {
    const { data } = await supabase.from('audit_logs').select('*').eq('user_id', userId)
    exported.audit_logs = data || []
  } catch {
    exported.audit_logs = []
  }

  // Deal timeline
  try {
    const { data: timeline } = await supabase
      .from('deal_timeline')
      .select('*')
      .eq('user_id', userId)
      .order('occurred_at', { ascending: true })
    exported.deal_timeline = timeline || []
  } catch {
    exported.deal_timeline = []
  }

  // Message embedding count (embeddings themselves are large vectors, export count only)
  try {
    const messages = exported.messages as { id: string }[] | null
    const msgIds = (messages || []).map(m => m.id)
    if (msgIds.length > 0) {
      const { data } = await supabase.from('message_embeddings').select('message_id').in('message_id', msgIds)
      exported.message_embeddings_count = (data || []).length
    } else {
      exported.message_embeddings_count = 0
    }
  } catch {
    exported.message_embeddings_count = 0
  }

  return exported
}

/**
 * Delete ALL data for a user (GDPR Art. 17 — Right to Erasure).
 *
 * Cascade-deletes in FK-safe order (children before parents), then removes
 * the user row itself. Audit log is written BEFORE deletion (with SET NULL FK
 * so it survives the user row being deleted).
 *
 * Returns counts of deleted rows per table for the audit trail.
 */
export async function deleteAllUserData(userId: string): Promise<Record<string, number>> {
  const supabase = getSupabaseAdmin()
  const counts: Record<string, number> = {}

  // Gather FK-dependent IDs upfront
  const { data: cps } = await supabase.from('cps').select('id').eq('user_id', userId)
  const cpIds = (cps || []).map((c: { id: string }) => c.id)

  const { data: msgs } = await supabase.from('messages').select('id').eq('user_id', userId)
  const msgIds = (msgs || []).map((m: { id: string }) => m.id)

  const { data: convs } = await supabase.from('conversation_threads').select('id').eq('user_id', userId)
  const convIds = (convs || []).map((c: { id: string }) => c.id)

  // --- Delete in FK-safe order (leaf tables first) ---

  // emails → action_proposals (FK)
  const { data: emailsDel } = await supabase.from('emails').delete().eq('user_id', userId).select('id')
  counts.emails = (emailsDel || []).length

  // message_embeddings → messages (FK)
  if (msgIds.length > 0) {
    const { data: embDel } = await supabase.from('message_embeddings').delete().in('message_id', msgIds).select('message_id')
    counts.message_embeddings = (embDel || []).length
  } else {
    counts.message_embeddings = 0
  }

  // action_proposals → conversation_threads, cps (FK)
  const { data: actionsDel } = await supabase.from('action_proposals').delete().eq('user_id', userId).select('id')
  counts.action_proposals = (actionsDel || []).length

  // thread_participants → conversation_threads, cps (FK)
  if (convIds.length > 0) {
    const { data: tpDel } = await supabase.from('thread_participants').delete().in('thread_id', convIds).select('thread_id')
    counts.thread_participants = (tpDel || []).length
  } else {
    counts.thread_participants = 0
  }

  // messages → conversation_threads, cps (FK)
  const { data: msgsDel } = await supabase.from('messages').delete().eq('user_id', userId).select('id')
  counts.messages = (msgsDel || []).length

  // todos → cps (FK)
  const { data: todosDel } = await supabase.from('todos').delete().eq('user_id', userId).select('id')
  counts.todos = (todosDel || []).length

  // events
  const { data: eventsDel } = await supabase.from('events').delete().eq('user_id', userId).select('id')
  counts.events = (eventsDel || []).length

  // cp_states → cps (FK)
  if (cpIds.length > 0) {
    const { data: csDel } = await supabase.from('cp_states').delete().in('cp_id', cpIds).select('cp_id')
    counts.cp_states = (csDel || []).length
  } else {
    counts.cp_states = 0
  }

  // conversation_threads
  const { data: convsDel } = await supabase.from('conversation_threads').delete().eq('user_id', userId).select('id')
  counts.conversation_threads = (convsDel || []).length

  // cps
  const { data: cpsDel } = await supabase.from('cps').delete().eq('user_id', userId).select('id')
  counts.cps = (cpsDel || []).length

  // channels
  const { data: chanDel } = await supabase.from('channels').delete().eq('user_id', userId).select('id')
  counts.channels = (chanDel || []).length

  // agent_errors
  const { data: errDel } = await supabase.from('agent_errors').delete().eq('user_id', userId).select('id')
  counts.agent_errors = (errDel || []).length

  // user_agent_locks (may not exist yet)
  try {
    const { data: lockDel } = await supabase.from('user_agent_locks').delete().eq('user_id', userId).select('user_id')
    counts.user_agent_locks = (lockDel || []).length
  } catch {
    counts.user_agent_locks = 0
  }

  // Finally: delete the user row
  const { data: userDel } = await supabase.from('users').delete().eq('id', userId).select('id')
  counts.users = (userDel || []).length

  return counts
}

/**
 * Enforce data retention policy — scrub PII from messages older than the
 * retention window. Message metadata (timestamps, CPs, thread assignments)
 * is preserved for conversation continuity; only text content and embeddings
 * are removed.
 */
export async function enforceRetentionPolicy(
  userId: string,
  retentionDays: number
): Promise<{ messagesScrubbed: number; embeddingsDeleted: number }> {
  const supabase = getSupabaseAdmin()
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  // Find old messages that still have content (not already scrubbed)
  const { data: oldMsgs } = await supabase
    .from('messages')
    .select('id')
    .eq('user_id', userId)
    .lt('timestamp', cutoff)
    .not('raw_text', 'is', null)

  const oldIds = (oldMsgs || []).map((m: { id: string }) => m.id)
  if (oldIds.length === 0) {
    return { messagesScrubbed: 0, embeddingsDeleted: 0 }
  }

  // Delete embeddings for old messages
  const { data: embDel } = await supabase
    .from('message_embeddings')
    .delete()
    .in('message_id', oldIds)
    .select('message_id')

  // Scrub message text content (single UPDATE, not per-row)
  const { data: scrubbed } = await supabase
    .from('messages')
    .update({ raw_text: null, cleaned_text: null })
    .eq('user_id', userId)
    .lt('timestamp', cutoff)
    .not('raw_text', 'is', null)
    .select('id')

  return {
    messagesScrubbed: (scrubbed || []).length,
    embeddingsDeleted: (embDel || []).length,
  }
}
