import { NextRequest, NextResponse } from 'next/server'
import { validateTriggerToken, generateActionToken } from '@/lib/auth/tokens'
import { getUserSettings } from '@/lib/db/users'
import { getPendingActionsForBrief, getRecentlyCompletedActions, updateAction } from '@/lib/db/actions'
import { getEventsForToday, getUpcomingEvents } from '@/lib/db/events'
import { getTodosDueToday, getOverdueTodos } from '@/lib/db/todos'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getCoolingConversations } from '@/lib/db/timeline'
import { generateBriefHeadline } from '@/lib/ai/mila-voice'
import { getActionIntent, formatSlotText } from '@/components/action/action-card-template'

/**
 * POST /api/brief/[userId]/refresh
 * Returns latest actions + events + completed items + todos + cooling contacts for client hydration.
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
    const [pendingActions, todayEvents, upcomingEvents, todosDueToday, overdueTodos, completedActions, coolingRaw] = await Promise.all([
      getPendingActionsForBrief(userId),
      getEventsForToday(userId, tz),
      getUpcomingEvents(userId, 3),
      getTodosDueToday(userId),
      getOverdueTodos(userId),
      getRecentlyCompletedActions(userId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      getCoolingConversations(userId, 5, 5),
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
      const payload = action.payload as Record<string, unknown> | null
      return {
        ...action,
        cpName: cp?.name || cp?.primary_identifier || null,
        cpRole: cp?.role || null,
        topic: conv?.topic || null,
        summaryJson: conv?.summary_json || null,
        headline: (payload?.headline as string) || null,
        story: (payload?.story as string) || null,
        actionToken: generateActionToken(action.id, userId),
      }
    })

    // On-demand headline generation for actions missing headlines
    const missingHeadlines = enrichedActions.filter(a => !a.headline)
    if (missingHeadlines.length > 0) {
      const hlResults = await Promise.allSettled(
        missingHeadlines.map(async (a) => {
          const p = a.payload as Record<string, unknown> | null
          const holdSlotText = (a.action_type === 'SCHEDULE' && p?.start && p?.end)
            ? formatSlotText(p.start as string, p.end as string) : null
          const daysIgnored = Math.max(0, Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86_400_000))
          const summary = a.summaryJson as { currentState?: string; risks?: string[]; dealType?: string | null } | null
          const hl = await generateBriefHeadline(
            {
              actionType: a.action_type,
              cpName: (a as Record<string, unknown>).cpName as string || '',
              dealValue: a.dollar_value || 0,
              urgency: a.urgency,
              intent: getActionIntent(a),
              daysSinceContact: daysIgnored,
              holdSlotText,
            },
            summary ? { currentState: summary.currentState, risks: summary.risks, dealType: summary.dealType } : null,
            [],
            settings
          )
          const existingPayload = (a.payload as Record<string, unknown>) || {}
          await updateAction(a.id, { payload: { ...existingPayload, headline: hl.headline, story: hl.story } }, userId)
          ;(a as Record<string, unknown>).headline = hl.headline
          ;(a as Record<string, unknown>).story = hl.story
        })
      )
      for (const r of hlResults) {
        if (r.status === 'rejected') console.error('[BriefRefresh] Headline generation failed:', r.reason)
      }
    }

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

    // Cooling contacts
    const coolingContacts = coolingRaw.map(c => ({
      conversationId: c.conversationId,
      cpName: c.cpName,
      topic: c.topic,
      daysSilent: c.daysSilent,
    }))

    const userName = settings.client_name || ''

    return NextResponse.json({
      userName,
      greeting: null,
      actions: enrichedActions,
      events: {
        today: todayEvents,
        upcoming: upcomingEvents,
      },
      todos: allTodos,
      completed: enrichedCompleted,
      coolingContacts,
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
