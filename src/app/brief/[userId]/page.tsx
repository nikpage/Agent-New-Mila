import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getUserById, getUserSettings } from '@/lib/db/users'
import { getPendingActionsForBrief, getRecentlyCompletedActions } from '@/lib/db/actions'
import { getEventsForToday, getUpcomingEvents } from '@/lib/db/events'
import { getTodosDueToday, getOverdueTodos } from '@/lib/db/todos'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { validateTriggerToken, generateTriggerToken } from '@/lib/auth/tokens'
import { BriefFeed } from '@/components/brief/BriefFeed'
import { theme } from '@/config/theme'
import type { BriefData, BriefAction, CompletedActionSummary } from '@/components/brief/types'

interface PageProps {
  params: Promise<{ userId: string }>
  searchParams: Promise<{ token?: string; focus?: string }>
}

async function loadBriefData(userId: string): Promise<BriefData> {
  const settings = await getUserSettings(userId)
  const tz = settings.timezone || 'Europe/Prague'

  const [pendingActions, todayEvents, upcomingEvents, todosDueToday, overdueTodos, completedActions] = await Promise.all([
    getPendingActionsForBrief(userId),
    getEventsForToday(userId, tz),
    getUpcomingEvents(userId, 3),
    getTodosDueToday(userId),
    getOverdueTodos(userId),
    getRecentlyCompletedActions(userId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
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
    }
  })

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

  return {
    actions: enrichedActions,
    events: {
      today: todayEvents as any,
      upcoming: upcomingEvents as any,
    },
    todos: allTodos as any,
    completed: enrichedCompleted,
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
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.background,
        padding: theme.spacing.md,
      }}>
        <div style={{ textAlign: 'center', maxWidth: '400px' }}>
          <h1 style={{ fontSize: theme.typography.sizes.xl, color: theme.colors.text, marginBottom: theme.spacing.sm }}>
            Neautorizovaný přístup
          </h1>
          <p style={{ color: theme.colors.textMuted }}>
            Tento odkaz je neplatný nebo vypršel. Otevřete brief z emailu od Míly.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main style={{
      minHeight: '100vh',
      backgroundColor: theme.colors.background,
      fontFamily: theme.typography.fontFamily,
    }}>
      <Suspense fallback={
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          color: theme.colors.textMuted,
        }}>
          Načítání...
        </div>
      }>
        <BriefContent userId={userId} token={token} focusActionId={focus} />
      </Suspense>
    </main>
  )
}
