import { getSupabaseAdmin } from '../supabase/client'
import type {
  ActionProposal,
  ActionProposalInsert,
  ActionStatus,
  ActionType,
  Json
} from '../supabase/types'

/**
 * Get an action proposal by ID
 */
export async function getActionById(actionId: string): Promise<ActionProposal | null> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .select('*')
    .eq('id', actionId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`Failed to get action: ${error.message}`)
  }

  return data
}

/**
 * Get action proposals for a user
 */
export async function getActionsForUser(
  userId: string,
  options?: {
    status?: ActionStatus
    actionType?: ActionType
    limit?: number
    orderBy?: 'priority_score' | 'created_at' | 'urgency'
  }
): Promise<ActionProposal[]> {
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('action_proposals')
    .select('*')
    .eq('user_id', userId)

  if (options?.status) {
    query = query.eq('status', options.status)
  }

  if (options?.actionType) {
    query = query.eq('action_type', options.actionType)
  }

  const orderBy = options?.orderBy || 'priority_score'
  query = query.order(orderBy, { ascending: false })

  if (options?.limit) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to get actions: ${error.message}`)
  }

  return data || []
}

/**
 * Get pending actions for morning brief
 */
export async function getPendingActionsForBrief(userId: string): Promise<ActionProposal[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .in('action_type', ['REPLY', 'SCHEDULE', 'TODO'])
    .order('priority_score', { ascending: false })

  if (error) {
    throw new Error(`Failed to get pending actions: ${error.message}`)
  }

  return data || []
}

/**
 * Get actions that were completed or approved since a given timestamp.
 * Used to show a "done" section in the morning brief so the user
 * sees what Mila already handled.
 */
export async function getRecentlyCompletedActions(
  userId: string,
  since: string
): Promise<ActionProposal[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['approved', 'completed'])
    .in('action_type', ['REPLY', 'SCHEDULE', 'TODO'])
    .gte('last_notified_at', since)
    .order('last_notified_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to get recently completed actions: ${error.message}`)
  }

  return data || []
}

/**
 * Get pending unsent SCHEDULE actions for batch optimization
 * Returns only actions that haven't had invites sent yet
 */
export async function getPendingScheduleActions(userId: string): Promise<ActionProposal[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .eq('action_type', 'SCHEDULE')
    .order('priority_score', { ascending: false })

  if (error) {
    throw new Error(`Failed to get pending schedule actions: ${error.message}`)
  }

  return data || []
}

/**
 * Create a new action proposal
 */
export async function createAction(action: ActionProposalInsert): Promise<ActionProposal> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .insert({
      ...action,
      status: action.status || 'pending',
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create action: ${error.message}`)
  }

  return data
}

/**
 * Update an action proposal
 */
export async function updateAction(
  actionId: string,
  updates: Partial<Omit<ActionProposal, 'id' | 'user_id' | 'created_at'>>
): Promise<ActionProposal> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .update(updates)
    .eq('id', actionId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update action: ${error.message}`)
  }

  return data
}

/**
 * Update action status
 */
export async function updateActionStatus(
  actionId: string,
  status: ActionStatus
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('action_proposals')
    .update({ status })
    .eq('id', actionId)

  if (error) {
    throw new Error(`Failed to update action status: ${error.message}`)
  }
}

/**
 * Mark action as approved and executed
 */
export async function approveAction(actionId: string): Promise<void> {
  await updateActionStatus(actionId, 'approved')
}

/**
 * Mark action as completed
 */
export async function completeAction(actionId: string): Promise<void> {
  await updateActionStatus(actionId, 'completed')
}

/**
 * Mark action as dismissed
 */
export async function dismissAction(actionId: string): Promise<void> {
  await updateActionStatus(actionId, 'dismissed')
}

/**
 * Dismiss all pending actions for a user
 */
export async function dismissAllPendingActions(userId: string): Promise<number> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .update({ status: 'dismissed' })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select('id')

  if (error) {
    throw new Error(`Failed to dismiss all actions: ${error.message}`)
  }

  return data?.length || 0
}

/**
 * Update action draft
 */
export async function updateActionDraft(
  actionId: string,
  subject: string,
  body: string
): Promise<void> {
  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('action_proposals')
    .update({
      draft_subject: subject,
      draft_body_text: body,
    })
    .eq('id', actionId)

  if (error) {
    throw new Error(`Failed to update action draft: ${error.message}`)
  }
}

/**
 * Mark actions as notified (for morning brief)
 */
export async function markActionsNotified(actionIds: string[]): Promise<void> {
  if (actionIds.length === 0) return

  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('action_proposals')
    .update({
      last_notified_at: new Date().toISOString(),
      queued_for_brief: false,
    })
    .in('id', actionIds)

  if (error) {
    throw new Error(`Failed to mark actions as notified: ${error.message}`)
  }
}

/**
 * Get high-urgency actions that haven't been instant-notified yet.
 * Returns actions across all users where urgency >= threshold,
 * status is pending, and last_notified_at is NULL (never sent).
 *
 * Uses urgency (AI-assessed immediate pressure) instead of priority_score
 * because priority_score includes daysIgnored² which makes it unreachable
 * on day 0 — exactly when urgent items need instant notification.
 */
export async function getHighPriorityUnnotifiedActions(
  urgencyThreshold: number = 9
): Promise<ActionProposal[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .select('*')
    .eq('status', 'pending')
    .eq('queued_for_brief', true)
    .is('last_notified_at', null)
    .gte('urgency', urgencyThreshold)
    .in('action_type', ['REPLY', 'SCHEDULE', 'TODO'])
    .order('priority_score', { ascending: false })

  if (error) {
    throw new Error(`Failed to get high-priority unnotified actions: ${error.message}`)
  }

  return data || []
}

/**
 * Mark actions as instant-notified: sets last_notified_at but keeps
 * queued_for_brief = true so the action still appears in the next
 * morning/afternoon brief if the user hasn't acted on it.
 */
export async function markActionsInstantNotified(actionIds: string[]): Promise<void> {
  if (actionIds.length === 0) return

  const supabase = getSupabaseAdmin()
  const { error } = await supabase
    .from('action_proposals')
    .update({
      last_notified_at: new Date().toISOString(),
    })
    .in('id', actionIds)

  if (error) {
    throw new Error(`Failed to mark actions as instant-notified: ${error.message}`)
  }
}

/**
 * Calculate priority score for an action
 *
 * Formula:
 * Score = (nVal × sellerMultiplier) + (urgency × daysIgnored^1.5) + weight
 *
 * Three additive terms:
 * - nVal × sellerMultiplier: deal size (percentage-based, floor 1) amplified by seller/buyer role
 * - urgency × daysIgnored^1.5: time pressure — urgency amplifies the aging curve
 * - weight: immovability (1-10 or 100), flat, added to score
 *
 * Zero handling: sellerMultiplier = 0 → replace with 1 to prevent score nullification
 */
export function calculatePriorityScore(params: {
  dollarValue: number
  urgency: number
  daysIgnored: number
  weight?: number
  sellerMultiplier?: number
  kcHighValue?: number
}): number {
  const {
    dollarValue,
    urgency,
    daysIgnored,
    weight = 0,
    sellerMultiplier = 1,
    kcHighValue = 5_000_000,
  } = params

  const safeSellerMultiplier = sellerMultiplier || 1
  const safeUrgency = urgency || 1
  const safeHigh = kcHighValue > 0 ? kcHighValue : 5_000_000

  // BaseDealScore: percentage-based normalization with hard floor of 1
  const baseDealScore = Math.max(1, Math.round((dollarValue / safeHigh) * 10))

  // Score = (BaseDealScore * sellerMultiplier) + (urgency * daysIgnored^1.5) + weight
  return Math.round(
    (baseDealScore * safeSellerMultiplier) +
    (safeUrgency * Math.pow(daysIgnored, 1.5)) +
    weight
  )
}

/**
 * Get actions for a specific conversation
 */
export async function getActionsForConversation(
  conversationId: string
): Promise<ActionProposal[]> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('action_proposals')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('priority_score', { ascending: false })

  if (error) {
    throw new Error(`Failed to get actions for conversation: ${error.message}`)
  }

  return data || []
}

/**
 * Get the set of action_type values that already exist for a conversation
 * and should NOT be re-proposed.
 *
 * Includes:
 *  - pending actions (not yet acted on)
 *  - approved/completed actions created within the last 7 days
 *    (prevents re-proposing meetings that were already confirmed,
 *     replies already sent, etc.)
 */
export async function getPendingActionTypes(conversationId: string): Promise<Set<string>> {
  const supabase = getSupabaseAdmin()

  // 1. All pending actions — always block re-proposal
  const { data: pending, error: pendingErr } = await supabase
    .from('action_proposals')
    .select('action_type')
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')

  if (pendingErr) {
    throw new Error(`Failed to get pending action types: ${pendingErr.message}`)
  }

  // 2. Recently approved/completed actions — prevent re-planning handled items
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recent, error: recentErr } = await supabase
    .from('action_proposals')
    .select('action_type')
    .eq('conversation_id', conversationId)
    .in('status', ['approved', 'completed'])
    .gte('created_at', sevenDaysAgo)

  if (recentErr) {
    throw new Error(`Failed to get recent action types: ${recentErr.message}`)
  }

  const types = new Set<string>()
  for (const r of pending || []) types.add(r.action_type)
  for (const r of recent || []) types.add(r.action_type)
  return types
}

/**
 * Check if there's an existing pending action for a conversation
 */
export async function hasPendingAction(conversationId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin()
  const { count, error } = await supabase
    .from('action_proposals')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')

  if (error) {
    throw new Error(`Failed to check pending action: ${error.message}`)
  }

  return (count || 0) > 0
}

/**
 * Check if there's an existing pending action for a CP across ALL conversations for a user.
 * Prevents duplicate actions when calendar ingestion and planning create separate conversations
 * for the same counterparty.
 */
export async function hasPendingActionForCP(userId: string, cpId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin()
  const { count, error } = await supabase
    .from('action_proposals')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('cp_id', cpId)
    .eq('status', 'pending')

  if (error) {
    throw new Error(`Failed to check pending action for CP: ${error.message}`)
  }

  return (count || 0) > 0
}
