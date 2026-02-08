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
    .order('priority_score', { ascending: false })

  if (error) {
    throw new Error(`Failed to get pending actions: ${error.message}`)
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
 * Calculate priority score for an action
 *
 * Formula:
 * Total Priority Score = (V_adjusted × Urgency) + (Pain Factor × (Days Ignored + 1)²) + Weight
 *
 * Zero handling: Any multiplier = 0 → replace with 1 to prevent score nullification
 */
export function calculatePriorityScore(params: {
  dollarValue: number
  urgency: number
  painFactor: number
  daysIgnored: number
  weight?: number
  offerMultiplier?: number
}): number {
  const {
    dollarValue,
    urgency,
    painFactor,
    daysIgnored,
    weight = 0,
    offerMultiplier = 1,
  } = params

  const safeOfferMultiplier = offerMultiplier || 1
  const safeUrgency = urgency || 1
  const safePainFactor = painFactor || 1
  const safeWeight = weight || 0

  const adjustedValue = dollarValue * safeOfferMultiplier
  const valueComponent = adjustedValue * safeUrgency
  const painComponent = safePainFactor * Math.pow(daysIgnored + 1, 2)

  return Math.round(valueComponent + painComponent + safeWeight)
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
