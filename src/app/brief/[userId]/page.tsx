import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getUserById, getUserSettings } from '@/lib/db/users'
import { getPendingActionsForBrief, getRecentlyCompletedActions, updateAction } from '@/lib/db/actions'
import { getEventsForToday, getUpcomingEvents } from '@/lib/db/events'
import { getTodosDueToday, getOverdueTodos } from '@/lib/db/todos'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getCoolingConversations } from '@/lib/db/timeline'
import { validateTriggerToken, generateActionToken } from '@/lib/auth/tokens'
import { BriefFeed } from '@/components/brief/BriefFeed'
import { generateBriefHeadline } from '@/lib/ai/mila-voice'
import { getActionIntent, formatSlotText } from '@/components/action/action-card-template'
import type { BriefData, BriefAction, CompletedActionSummary, CoolingContact } from '@/components/brief/types'

interface PageProps {
  params: Promise<{ userId: string }>
  searchParams: Promise<{ token?: string; focus?: string }>
}

async function loadBriefData(userId: string): Promise<BriefData> {
  const settings = await getUserSettings(userId)
  const tz = settings.timezone || 'Europe/Prague'

  const [pendingActions, todayEvents, upcomingEvents, todosDueToday, overdueTodos, completedActions, coolingRaw] = await Promise.all([
    getPendingActionsForBrief(userId),
    getEventsForToday(userId, tz),
    getUpcomingEvents(userId, 3),
    getTodosDueToday(userId),
    getOverdueTodos(userId),
    getRecentlyCompletedActions(userId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    getCoolingConversations(userId, 5, 5),
  ])

  // Enrich actions with CP + conversation data
  const cpIds = [...new Set([...pendingActions, ...completedActions].map(a => a.cp_id))]
  const convIds = [...new Set([...pendingActions, ...completedActions].map(a => a.conversation_id))]

  const [cps, conversations] = await Promise.all([
    Promise.all(cpIds.map(id => getCPById(id))),
    Promise.all(convIds.map(id => getConversationById(id))),
  ])

  const cpMap = new Map(cps.filter(Boolean).map(cp => [cp!.id, cp!]))
  const convMap = new Map(conversations.filter(Boolean).map(c => [c!.id, c!]))

  const enrichedActions: BriefAction[] = pendingActions.map(action => {
    const cp = cpMap.get(action.cp_id)
    const conv = convMap.get(action.conversation_id)
    const summary = conv?.summary_json as BriefAction['summaryJson']
    const payload = action.payload as Record<string, unknown> | null
    return {
      ...action,
      cpName: cp?.name || cp?.primary_identifier || null,
      cpRole: cp?.role || null,
      topic: conv?.topic || null,
      summaryJson: summary,
      headline: (payload?.headline as string) || null,
      story: (payload?.story as string) || null,
      actionToken: generateActionToken(action.id, userId),
    }
  })

  // On-demand headline generation: if any action is missing a headline, generate + persist it
  const missingHeadlines = enrichedActions.filter(a => !a.headline)
  if (missingHeadlines.length > 0) {
    const results = await Promise.allSettled(
      missingHeadlines.map(async (a) => {
        const p = a.payload as Record<string, unknown> | null
        const holdSlotText = (a.action_type === 'SCHEDULE' && p?.start && p?.end)
          ? formatSlotText(p.start as string, p.end as string) : null
        const daysIgnored = Math.max(0, Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86_400_000))
        const summary = a.summaryJson
        const hl = await generateBriefHeadline(
          {
            actionType: a.action_type,
            cpName: a.cpName || '',
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
        // Persist so next load is instant
        const existingPayload = (a.payload as Record<string, unknown>) || {}
        await updateAction(a.id, { payload: { ...existingPayload, headline: hl.headline, story: hl.story } })
        // Update in-place for this render
        a.headline = hl.headline
        a.story = hl.story
      })
    )
    // Log failures but don't block the page
    for (const r of results) {
      if (r.status === 'rejected') console.error('[BriefPage] Headline generation failed:', r.reason)
    }
  }

  const enrichedCompleted: CompletedActionSummary[] = completedActions.map(action => {
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
  const coolingContacts: CoolingContact[] = coolingRaw.map(c => ({
    conversationId: c.conversationId,
    cpName: c.cpName,
    topic: c.topic,
    daysSilent: c.daysSilent,
  }))

  // User name from settings
  const userName = settings.client_name || ''

  return {
    userName,
    greeting: null, // AI greeting populated by brief sender; web brief generates its own
    actions: enrichedActions,
    events: {
      today: todayEvents as any,
      upcoming: upcomingEvents as any,
    },
    todos: allTodos as any,
    completed: enrichedCompleted,
    coolingContacts,
    settings: {
      timezone: tz,
      aiLanguage: settings.ai_language || 'Czech',
      aiToneUser: settings.ai_tone_user || 'professional and concise',
    },
  }
}

async function BriefContent({ userId, token, focusActionId }: { userId: string; token: string; focusActionId?: string }) {
  const data = await loadBriefData(userId)

  return (
    <BriefFeed
      initialData={data}
      userId={userId}
      token={token}
      focusActionId={focusActionId}
    />
  )
}

export default async function BriefPage({ params, searchParams }: PageProps) {
  const { userId } = await params
  const { token, focus } = await searchParams

  // Validate user exists
  const user = await getUserById(userId)
  if (!user) {
    notFound()
  }

  // Auth: validate trigger token
  if (!token || !validateTriggerToken(token, userId)) {
    return (
      <main style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}>
        <div style={{ textAlign: 'center', maxWidth: '400px' }}>
          <h1 style={{ fontSize: '19px', color: 'var(--txt)', marginBottom: '8px', fontFamily: 'Georgia, serif' }}>
            Neautorizovaný přístup
          </h1>
          <p style={{ color: 'var(--mtd)' }}>
            Tento odkaz je neplatný nebo vypršel. Otevřete brief z emailu od Míly.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main style={{ minHeight: '100dvh' }}>
      <Suspense fallback={
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100dvh',
          color: 'var(--sub)',
        }}>
          Načítání...
        </div>
      }>
        <BriefContent userId={userId} token={token} focusActionId={focus} />
      </Suspense>
    </main>
  )
}
