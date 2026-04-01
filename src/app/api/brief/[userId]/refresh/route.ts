import { NextRequest, NextResponse } from 'next/server'
import { validateTriggerToken } from '@/lib/auth/tokens'
import { getUserSettings } from '@/lib/db/users'
import { getPendingActionsForBrief, getRecentlyCompletedActions } from '@/lib/db/actions'
import { getEventsForToday, getUpcomingEvents } from '@/lib/db/events'
import { getTodosDueToday, getOverdueTodos } from '@/lib/db/todos'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'

/**
 * POST /api/brief/[userId]/refresh
 * Returns latest actions + events + completed items + todos for client hydration.
 * Auth: trigger token (HMAC tied to userId).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params
    const body = await request.json()
    const { token } = body

    if (!token || !validateTriggerToken(token, userId)) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const settings = await getUserSettings(userId)
    const tz = settings.timezone || 'Europe/Prague'

    // Fetch all data in parallel
    const [pendingActions, todayEvents, upcomingEvents, todosDueToday, overdueTodos, completedActions] = await Promise.all([
      getPendingActionsForBrief(userId),
      getEventsForToday(userId, tz),
      getUpcomingEvents(userId, 3),
      getTodosDueToday(userId),
      getOverdueTodos(userId),
      getRecentlyCompletedActions(userId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ])

    // Enrich actions with CP names and conversation topics (batched)
    const cpIds = [...new Set(pendingActions.map(a => a.cp_id))]
    const convIds = [...new Set(pendingActions.map(a => a.conversation_id))]

    const [cps, conversations] = await Promise.all([
      Promise.all(cpIds.map(id => getCPById(id))),
      Promise.all(convIds.map(id => getConversationById(id))),
    ])

    const cpMap = new Map(cps.filter(Boolean).map(cp => [cp!.id, cp!]))
    const convMap = new Map(conversations.filter(Boolean).map(c => [c!.id, c!]))

    const enrichedActions = pendingActions.map(action => {
      const cp = cpMap.get(action.cp_id)
      const conv = convMap.get(action.conversation_id)
      return {
        ...action,
        cpName: cp?.name || cp?.primary_identifier || null,
        cpRole: cp?.role || null,
        topic: conv?.topic || null,
        summaryJson: conv?.summary_json || null,
      }
    })

    // Enrich completed actions with CP names
    const completedCpIds = [...new Set(completedActions.map(a => a.cp_id))]
    const completedCps = await Promise.all(completedCpIds.filter(id => !cpMap.has(id)).map(id => getCPById(id)))
    for (const cp of completedCps) {
      if (cp) cpMap.set(cp.id, cp)
    }
    const enrichedCompleted = completedActions.map(action => {
      const cp = cpMap.get(action.cp_id)
      const conv = convMap.get(action.conversation_id)
      return {
        id: action.id,
        actionType: action.action_type,
        cpName: cp?.name || cp?.primary_identifier || null,
        topic: conv?.topic || null,
        intentCs: action.intent_cs,
        completedAt: action.updated_at,
      }
    })

    // Deduplicate todos
    const todoIds = new Set<string>()
    const allTodos = [...overdueTodos, ...todosDueToday].filter(t => {
      if (todoIds.has(t.id)) return false
      todoIds.add(t.id)
      return true
    })

    return NextResponse.json({
      actions: enrichedActions,
      events: {
        today: todayEvents,
        upcoming: upcomingEvents,
      },
      todos: allTodos,
      completed: enrichedCompleted,
      settings: {
        timezone: tz,
        aiLanguage: settings.ai_language,
        aiToneUser: settings.ai_tone_user,
      },
    })
  } catch (error) {
    console.error('[BriefRefresh]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 }
    )
  }
}
