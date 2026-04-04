/**
 * Morning Brief Service
 * Generates and sends the daily morning brief email
 */

import { getPendingActionsForBrief, markActionsNotified, getHighPriorityUnnotifiedActions, markActionsInstantNotified, getRecentlyCompletedActions, updateAction } from '@/lib/db/actions'
import { getUserById, getUsersDueBrief, getUserSettings, updateUserSettings } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getEventsForToday, getUpcomingEvents } from '@/lib/db/events'
import { getTodosDueToday, getOverdueTodos } from '@/lib/db/todos'
import { sendEmail, getUserEmail } from '@/lib/google/gmail'
import { generateBriefIntro, generateQuietBriefIntro, generateUrgentIntro, generateBriefHeadline } from '@/lib/ai/mila-voice'
import { optimizeScheduleActions, scheduleSingleAction } from '@/services/scheduling'
import { ensureBriefSchedules } from '@/lib/qstash/client'
import { generateActionToken, generateTriggerToken } from '@/lib/auth/tokens'
import { getActionCardEmailHtml, formatSlotText, getActionIntent, prepareEmailCardParams, PRAGUE_TZ } from '../components/action/action-card-template';
import { getHeadlineEmailHtml, getHeadlineEmailText } from '../components/brief/headline-email-template'
import type { HeadlineAction, HeadlineEvent, HeadlineCompleted } from '../components/brief/headline-email-template'
import { theme } from '@/config/theme'
import type { ActionProposal, ConversationSummary } from '@/lib/supabase/types'

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000'

interface BriefAction {
  action:   ActionProposal
  cpName:   string
  cpRole:   string | null
  topic:    string
  dealType: string | null
  summary:  ConversationSummary | null
  actionUrl: string
  editUrl: string
  executeUrl: string
  todoUrl: string
  blacklistUrl: string
  resolveRescheduleUrl: string | null
  resolveCancelUrl: string | null
  resolveMoveNewUrl: string | null
  resolveKeepBothUrl: string | null
}

export type BriefType = 'morning' | 'afternoon'

/**
 * Generate and send a brief for a user
 */
export async function sendMorningBrief(userId: string, briefType: BriefType = 'morning'): Promise<boolean> {
  try {
    console.log(`[Brief] Loading user ${userId}`)
    const user = await getUserById(userId)
    if (!user || !user.email_enabled || user.email_unsubscribed) {
      console.log(`[Brief] User ${userId}: skipped — ${!user ? 'not found' : user.email_unsubscribed ? 'unsubscribed' : 'email disabled'}`)
      return false
    }

    // Self-heal: verify QStash schedules exist, recreate if missing
    const settings = await getUserSettings(userId)
    try {
      await ensureBriefSchedules(userId, settings, updateUserSettings)
    } catch (scheduleError) {
      console.error(`[Brief] User ${user.email || userId}: schedule self-heal failed:`, scheduleError)
    }

    // Run batch schedule optimizer BEFORE loading actions —
    // re-optimizes holds, respects buffers, deduplicates across meetings
    try {
      const optimizeResult = await optimizeScheduleActions(userId)
      if (optimizeResult.optimized > 0 || optimizeResult.moveSuggestions.length > 0) {
        console.log(`[Brief] User ${user.email || userId}: optimizer — ${optimizeResult.optimized} optimized, ${optimizeResult.unscheduled} unscheduled, ${optimizeResult.moveSuggestions.length} move suggestions`)
      }
    } catch (optimizeError) {
      console.error(`[Brief] User ${user.email || userId}: optimizer failed, continuing with existing holds:`, optimizeError)
    }

    const actions = await getPendingActionsForBrief(userId)
    // Fetch actions completed/approved in the last 24h — shows user what Mila already handled
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const completedActions = await getRecentlyCompletedActions(userId, twentyFourHoursAgo)
    console.log(`[Brief] User ${user.email || userId}: ${actions.length} pending actions, ${completedActions.length} completed`)

    const events = await getEventsForToday(userId, user.email_timezone)
    console.log(`[Brief] User ${user.email || userId}: ${events.length} events today`)

    // Enrich completed actions for the "done" section (shared by quiet + normal brief)
    interface CompletedBriefItem {
      cpName: string
      topic: string
      actionType: string
      intent: string
    }
    const completedItems: CompletedBriefItem[] = []
    for (const action of completedActions) {
      const [cp, conversation] = await Promise.all([
        getCPById(action.cp_id),
        getConversationById(action.conversation_id),
      ])
      if (!cp || !conversation) continue
      completedItems.push({
        cpName: cp.name || cp.primary_identifier,
        topic: conversation.topic,
        actionType: action.action_type,
        intent: action.intent_cs || action.rationale_cs || action.rationale || '',
      })
    }

    // Fetch recent command results from audit logs (self-email commands processed since last brief)
    interface CommandBriefItem {
      commandType: string
      summary: string
      timestamp: string
    }
    const commandItems: CommandBriefItem[] = []
    try {
      const supabase = (await import('@/lib/supabase/client')).getSupabaseAdmin()
      const { data: cmdLogs } = await supabase
        .from('audit_logs')
        .select('action, details, created_at')
        .eq('user_id', userId)
        .like('action', 'command:%')
        .gte('created_at', twentyFourHoursAgo)
        .not('action', 'eq', 'command:error')
        .order('created_at', { ascending: false })
        .limit(10)
      if (cmdLogs) {
        for (const log of cmdLogs) {
          const details = log.details as Record<string, unknown> | null
          if (details?.success) {
            commandItems.push({
              commandType: (log.action as string).replace('command:', ''),
              summary: (details.summary as string) || '',
              timestamp: log.created_at,
            })
          }
        }
      }
    } catch (cmdErr) {
      console.error(`[Brief] Command log fetch failed for ${userId}:`, cmdErr)
    }

    // ─── Quiet brief: no pending actions ──────────────────────────────────────
    if (actions.length === 0) {
      console.log(`[Brief] User ${user.email || userId}: no actions — sending quiet brief`)
      const settings = await getUserSettings(userId)
      const [upcomingEvents, todosToday, overdueTodos] = await Promise.all([
        getUpcomingEvents(userId, 3),
        getTodosDueToday(userId),
        getOverdueTodos(userId),
      ])
      const allTodos = [...overdueTodos, ...todosToday]
        .filter((t, i, arr) => arr.findIndex(x => x.id === t.id) === i)

      const eventItems = events.map(e => ({
        title: e.title || 'Event',
        time: new Date(e.start_time).toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZone: user.email_timezone,
        }),
      }))

      const todoItems = allTodos.slice(0, 5).map(t => ({
        title: t.description,
        due: t.due_date ? new Date(t.due_date).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long' }) : undefined,
      }))

      let quietGreeting: string, quietSubject: string, quietBody: string
      try {
        const intro = await generateQuietBriefIntro(briefType, eventItems, todoItems, settings)
        quietGreeting = intro.greeting
        quietSubject = intro.subject
        quietBody = intro.body
      } catch (err) {
        console.error(`[Brief] Quiet brief intro generation failed for ${userId}:`, err)
        quietGreeting = briefType === 'morning' ? 'Hezké ráno' : 'Hezké odpoledne'
        quietSubject = 'Mila: Vše v pořádku'
        quietBody = 'Žádné nové akce ke zpracování. Užijte si klidný den.'
      }

      const upcomingNonToday = upcomingEvents.filter(e => {
        const eventDate = new Date(e.start_time).toDateString()
        const todayDate = new Date().toDateString()
        return eventDate !== todayDate
      })

      const htmlContent = generateQuietBriefEmailHtml(
        quietGreeting, quietBody, eventItems,
        upcomingNonToday.slice(0, 5).map(e => ({
          title: e.title || 'Event',
          date: new Date(e.start_time).toLocaleDateString('cs-CZ', {
            weekday: 'long', day: 'numeric', month: 'long', timeZone: user.email_timezone,
          }),
          time: new Date(e.start_time).toLocaleTimeString('cs-CZ', {
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: user.email_timezone,
          }),
        })),
        todoItems,
        commandItems
      )
      const textContent = `${quietGreeting}\n\n${quietBody}`
      const userEmail = await getUserEmail(userId)
      await sendEmail(userId, { to: userEmail, subject: quietSubject, body: textContent, htmlBody: htmlContent })
      console.log(`[Brief] User ${user.email || userId}: quiet ${briefType} brief sent`)
      return true
    }

    // ─── Normal brief: has pending actions ────────────────────────────────────
    const briefActions: BriefAction[] = []

    for (const action of actions) {
      const [cp, conversation] = await Promise.all([
        getCPById(action.cp_id),
        getConversationById(action.conversation_id),
      ])

      if (!cp || !conversation) {
        console.warn(`[MorningBrief] Skipping orphaned action ${action.id} — missing cp=${action.cp_id} or conv=${action.conversation_id}`)
        continue
      }

      const token = generateActionToken(action.id, userId)
      const actionUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&view=details`
      const editUrl = `${APP_BASE_URL}/action/${action.id}/edit?token=${token}`
      const executeUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&do=execute&type=${action.action_type}`
      const todoUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&do=todo`
      const blacklistUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&do=blacklist`

      // Conflict resolution URLs (only for SCHEDULE actions with conflicts)
      const actionPayload = action.payload as Record<string, unknown> | null
      const unresolvedConflicts = action.action_type === 'SCHEDULE' && Array.isArray(actionPayload?.conflicts)
        ? (actionPayload!.conflicts as Record<string, unknown>[]).filter(c => !c.resolved)
        : []
      const hasConflicts = unresolvedConflicts.length > 0
      const firstUnresolvedIdx = hasConflicts
        ? (actionPayload!.conflicts as Record<string, unknown>[]).findIndex(c => !c.resolved)
        : 0
      const resolveRescheduleUrl = hasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=reschedule_existing&conflict_idx=${firstUnresolvedIdx}` : null
      const resolveCancelUrl = hasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=cancel_existing&conflict_idx=${firstUnresolvedIdx}` : null
      const resolveMoveNewUrl = hasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=move_new&conflict_idx=${firstUnresolvedIdx}` : null
      const resolveKeepBothUrl = hasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=keep_both&conflict_idx=${firstUnresolvedIdx}` : null

      briefActions.push({
        action,
        cpName:   cp.name || cp.primary_identifier,
        cpRole:   cp.role || null,
        topic:    conversation.topic,
        dealType: conversation.deal_type || null,
        summary:  conversation.summary_json as ConversationSummary | null,
        actionUrl,
        editUrl,
        executeUrl,
        todoUrl,
        blacklistUrl,
        resolveRescheduleUrl,
        resolveCancelUrl,
        resolveMoveNewUrl,
        resolveKeepBothUrl,
      })
    }

    // ─── Generate AI headlines for ALL actions BEFORE filtering ───────────────
    // Headlines are persisted on the action so they're ready when the action surfaces
    // in a later brief (e.g. after a TODO is completed and the suppressed REPLY appears).
    const briefSettings = await getUserSettings(userId)
    const calendarForHeadlines = events.map(e => ({
      time: new Date(e.start_time).toLocaleTimeString('cs-CZ', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: user.email_timezone,
      }),
      title: e.title || 'Event',
    }))

    const allHeadlineResults = await Promise.allSettled(
      briefActions.map(ba => {
        const p = ba.action.payload as Record<string, unknown> | null
        const holdSlotText = (ba.action.action_type === 'SCHEDULE' && p?.start && p?.end)
          ? formatSlotText(p.start as string, p.end as string) : null
        const daysIgnored = Math.max(0, Math.floor((Date.now() - new Date(ba.action.created_at).getTime()) / 86_400_000))
        return generateBriefHeadline(
          {
            actionType: ba.action.action_type,
            cpName: ba.cpName,
            dealValue: ba.action.dollar_value || 0,
            urgency: ba.action.urgency,
            intent: getActionIntent(ba.action),
            daysSinceContact: daysIgnored,
            holdSlotText,
          },
          ba.summary ? { currentState: ba.summary.currentState, risks: ba.summary.risks, dealType: ba.summary.dealType } : null,
          calendarForHeadlines,
          briefSettings
        )
      })
    )

    // Build headline map and persist on ALL actions (including those that will be filtered)
    const allHeadlineActions: HeadlineAction[] = briefActions.map((ba, i) => {
      const result = allHeadlineResults[i]
      const hl = result.status === 'fulfilled' ? result.value : { headline: ba.cpName, story: ba.action.intent_cs || ba.action.rationale || '' }
      const p = ba.action.payload as Record<string, unknown> | null
      const slotText = (ba.action.action_type === 'SCHEDULE' && p?.start && p?.end)
        ? formatSlotText(p.start as string, p.end as string) : null
      return {
        id: ba.action.id,
        actionType: ba.action.action_type,
        cpName: ba.cpName,
        urgency: ba.action.urgency,
        headline: hl.headline,
        story: hl.story,
        slotText,
      }
    })

    await Promise.allSettled(
      allHeadlineActions.map(ha => {
        const ba = briefActions.find(b => b.action.id === ha.id)
        if (!ba) return Promise.resolve()
        const existingPayload = (ba.action.payload as Record<string, unknown>) || {}
        return updateAction(ha.id, {
          payload: { ...existingPayload, headline: ha.headline, story: ha.story },
        })
      })
    )

    // ─── Order and filter actions for the brief ─────────────────────────────
    // 1. Group by conversation
    // 2. Within each conversation: if both TODO (prep) and REPLY/SCHEDULE (CP action) exist,
    //    show only the TODO unless both are urgent (>= 9). Prep first, then act.
    // 3. Sort conversations by highest urgency action (most urgent first)
    // 4. Within a conversation, logical order: TODO before REPLY/SCHEDULE
    const conversationGroups = new Map<string, BriefAction[]>()
    for (const ba of briefActions) {
      const convId = ba.action.conversation_id
      const group = conversationGroups.get(convId) || []
      group.push(ba)
      conversationGroups.set(convId, group)
    }

    const orderedBriefActions: BriefAction[] = []
    const conversationEntries = Array.from(conversationGroups.entries())

    // Sort conversations by highest urgency action descending
    conversationEntries.sort((a, b) => {
      const maxUrgencyA = Math.max(...a[1].map(ba => ba.action.urgency ?? 0))
      const maxUrgencyB = Math.max(...b[1].map(ba => ba.action.urgency ?? 0))
      if (maxUrgencyB !== maxUrgencyA) return maxUrgencyB - maxUrgencyA
      const maxScoreA = Math.max(...a[1].map(ba => ba.action.priority_score ?? 0))
      const maxScoreB = Math.max(...b[1].map(ba => ba.action.priority_score ?? 0))
      return maxScoreB - maxScoreA
    })

    for (const [, group] of conversationEntries) {
      // Sort within group: TODO first, then REPLY/SCHEDULE (logical dependency order)
      group.sort((a, b) => {
        const typeOrder = (t: string) => t === 'TODO' ? 0 : t === 'REPLY' ? 1 : t === 'SCHEDULE' ? 2 : 3
        return typeOrder(a.action.action_type) - typeOrder(b.action.action_type)
      })

      const hasTodo = group.some(ba => ba.action.action_type === 'TODO')
      const hasCpAction = group.some(ba => ba.action.action_type === 'REPLY' || ba.action.action_type === 'SCHEDULE')
      const allUrgent = group.every(ba => (ba.action.urgency ?? 0) >= 9)

      if (hasTodo && hasCpAction && !allUrgent) {
        // Show only the TODO — CP action waits until prep is done
        for (const ba of group) {
          if (ba.action.action_type === 'TODO') {
            orderedBriefActions.push(ba)
          }
        }
      } else {
        // Show all actions in the group
        for (const ba of group) {
          orderedBriefActions.push(ba)
        }
      }
    }

    // Replace briefActions with ordered+filtered version
    briefActions.length = 0
    briefActions.push(...orderedBriefActions)

    let greeting: string
    let headline: string
    let briefSubject: string
    try {
      const intro = await generateBriefIntro(
        briefType,
        briefActions.length,
        events.map(e => ({
          title: e.title || 'Event',
          time: new Date(e.start_time).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: user.email_timezone,
          }),
        })),
        briefActions.map(b => ({
          type: b.action.action_type,
          cpName: b.cpName,
          urgency: b.action.urgency,
          intent: b.action.intent_cs || b.action.rationale_cs || b.action.rationale || '',
          dollarValue: b.action.dollar_value || 0,
        })),
        await getUserSettings(userId)
      )
      greeting = intro.greeting
      headline = intro.headline
      briefSubject = intro.subject
    } catch (introError) {
      console.error(`[MorningBrief] Brief intro generation failed for user ${userId}, using fallback:`, introError)
      greeting = briefType === 'morning' ? 'Hezké ráno' : 'Hezké odpoledne'
      headline = `Mate ${briefActions.length} akcnich navrhu ke zpracovani.`
      briefSubject = `Mila: ${briefActions.length} akci`
    }

    // Headlines already generated + persisted for ALL actions above the filter.
    // Now filter to only the actions that survived for the brief email.
    const briefActionIds = new Set(briefActions.map(ba => ba.action.id))
    const headlineActions = allHeadlineActions.filter(ha => briefActionIds.has(ha.id))

    // Build brief URL with trigger token
    const triggerToken = generateTriggerToken(userId)
    const briefUrl = `${APP_BASE_URL}/brief/${userId}?token=${triggerToken}`

    const headlineEvents: HeadlineEvent[] = events.map(e => ({
      title: e.title || 'Event',
      time: new Date(e.start_time).toLocaleTimeString('cs-CZ', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: user.email_timezone,
      }),
      location: e.location || undefined,
      isHold: e.status === 'tentative' || e.event_type === 'hold',
    }))

    const headlineCompleted: HeadlineCompleted[] = completedItems.map(item => ({
      cpName: item.cpName,
      actionType: item.actionType,
      topic: item.topic,
    }))

    const htmlContent = getHeadlineEmailHtml({
      greeting: `${greeting}${headline ? `\n${headline}` : ''}`,
      briefUrl,
      actions: headlineActions,
      events: headlineEvents,
      completed: headlineCompleted,
    })

    const textContent = getHeadlineEmailText({
      greeting: `${greeting}\n${headline}`,
      briefUrl,
      actions: headlineActions,
      events: headlineEvents,
      completed: headlineCompleted,
    })

    const userEmail = await getUserEmail(userId)

    await sendEmail(userId, {
      to: userEmail,
      subject: briefSubject,
      body: textContent,
      htmlBody: htmlContent,
    })

    await markActionsNotified(briefActions.map(b => b.action.id))
    console.log(`[Brief] User ${user.email || userId}: ${briefType} brief sent with ${briefActions.length} actions`)
    return true
  } catch (error) {
    console.error(`[Brief] User ${userId}: FAILED —`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Send briefs to all users whose configured brief time is due now.
 * windowMinutes controls how wide the "due now" window is (default 30 min).
 *
 * Processes up to CONCURRENCY users in parallel to stay within Vercel's
 * 300s function timeout. At ~10s per user and concurrency=10, this handles
 * ~100 users before the deadline (with headroom for slow AI calls).
 */
const BRIEF_CONCURRENCY = 10

export async function sendAllMorningBriefs(
  briefType: BriefType = 'morning',
  windowMinutes: number = 30
): Promise<{ sent: number; failed: number }> {
  const users = await getUsersDueBrief(briefType, windowMinutes)
  console.log(`[Brief] ${briefType}: found ${users.length} user(s) due within ${windowMinutes}-min window`)
  let sent = 0
  let failed = 0

  // Process in batches of BRIEF_CONCURRENCY
  for (let i = 0; i < users.length; i += BRIEF_CONCURRENCY) {
    const batch = users.slice(i, i + BRIEF_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(user => sendMorningBrief(user.id, briefType))
    )
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        sent++
      } else {
        failed++
      }
    }
  }

  return { sent, failed }
}

/**
 * Generate HTML email content — card rendering delegated to ActionCard.tsx
 */
function generateBriefEmailHtml(
  userId: string,
  greeting: string,
  headline: string,
  actions: BriefAction[],
  events: { title: string; time: string; location?: string }[],
  completedItems: { cpName: string; topic: string; actionType: string; intent: string }[] = [],
  commandItems: { commandType: string; summary: string; timestamp: string }[] = []
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.colors.background}; font-family: 'Inter', system-ui, sans-serif; color: ${theme.colors.text};">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <h1 style="font-size: 24px; margin-bottom: 8px; color: ${theme.colors.text};">${greeting}</h1>
    <p style="color: ${theme.colors.textMuted}; font-size: 16px; line-height: 1.5; margin-bottom: 32px;">${headline}</p>

    ${actions.map(({ action, cpName, cpRole, topic, summary, actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl, resolveRescheduleUrl, resolveCancelUrl, resolveMoveNewUrl, resolveKeepBothUrl }) => {
      return getActionCardEmailHtml(prepareEmailCardParams(
        action,
        { cpName, cpRole, topic, context: summary?.currentState || null },
        { actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl, resolveRescheduleUrl, resolveCancelUrl, resolveMoveNewUrl, resolveKeepBothUrl },
      ))
    }).join('')}

    ${completedItems.length > 0 ? `
    <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid ${theme.colors.border};">
      <h2 style="font-size: 18px; color: ${theme.colors.textMuted}; margin-bottom: 16px;">Co už Mila vyřídila</h2>
      ${completedItems.map(item => {
        const typeLabel = item.actionType === 'REPLY' ? 'Odpověď' : item.actionType === 'SCHEDULE' ? 'Schůzka' : 'Úkol'
        return `
        <div style="padding: 12px 16px; margin-bottom: 8px; background: ${theme.colors.surface}; border-radius: 8px; border-left: 3px solid ${theme.colors.success};">
          <div style="font-size: 14px; color: ${theme.colors.text}; font-weight: 500;">${item.cpName} · ${typeLabel}</div>
          <div style="font-size: 13px; color: ${theme.colors.textMuted}; margin-top: 4px;">${item.topic}</div>
        </div>`
      }).join('')}
    </div>` : ''}

    ${commandItems.length > 0 ? `
    <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid ${theme.colors.border};">
      <h2 style="font-size: 18px; color: ${theme.colors.textMuted}; margin-bottom: 16px;">Zpracované příkazy</h2>
      ${commandItems.map(item => {
        const typeLabel = item.commandType === 'new_contact' ? 'Nový kontakt' : item.commandType === 'todo' ? 'Úkol' : item.commandType
        return `
        <div style="padding: 12px 16px; margin-bottom: 8px; background: ${theme.colors.surface}; border-radius: 8px; border-left: 3px solid ${theme.colors.primary};">
          <div style="font-size: 14px; color: ${theme.colors.text}; font-weight: 500;">${typeLabel}</div>
          <div style="font-size: 13px; color: ${theme.colors.textMuted}; margin-top: 4px;">${item.summary}</div>
        </div>`
      }).join('')}
    </div>` : ''}
  </div>
</body>
</html>`.trim()
}

/**
 * Generate plain text email content
 */
function generateBriefEmailText(
  greeting: string,
  headline: string,
  actions: BriefAction[],
  completedItems: { cpName: string; topic: string; actionType: string; intent: string }[] = [],
  commandItems: { commandType: string; summary: string; timestamp: string }[] = []
): string {
  let text = `${greeting}\n\n${headline}\n\n`;
  for (const { action, cpName, cpRole, topic, actionUrl } of actions) {
    const intent = action.intent_cs || action.rationale_cs || action.rationale;
    text += `${cpName}${cpRole ? ` · ${cpRole}` : ''}\n`;
    text += `${topic}\n`;
    text += `Priorita: ${Math.round(action.priority_score)}\n\n`;
    text += `${intent}\n\n`;
    text += `▸ Detaily / Akce: ${actionUrl}\n`;
    text += `------------------------------------------\n\n`;
  }
  if (completedItems.length > 0) {
    text += `\n=== Co už Mila vyřídila ===\n\n`;
    for (const item of completedItems) {
      const typeLabel = item.actionType === 'REPLY' ? 'Odpověď' : item.actionType === 'SCHEDULE' ? 'Schůzka' : 'Úkol'
      text += `✓ ${item.cpName} · ${typeLabel}\n`;
      text += `  ${item.topic}\n\n`;
    }
  }
  if (commandItems.length > 0) {
    text += `\n=== Zpracované příkazy ===\n\n`;
    for (const item of commandItems) {
      const typeLabel = item.commandType === 'new_contact' ? 'Nový kontakt' : item.commandType === 'todo' ? 'Úkol' : item.commandType
      text += `✓ ${typeLabel}: ${item.summary}\n\n`;
    }
  }
  return text;
}

// ─── Quiet Brief (no actions) ────────────────────────────────────────────────

function generateQuietBriefEmailHtml(
  greeting: string,
  body: string,
  todayEvents: { title: string; time: string }[],
  upcomingEvents: { title: string; date: string; time: string }[],
  todos: { title: string; due?: string }[],
  commandItems: { commandType: string; summary: string; timestamp: string }[] = []
): string {
  const eventRows = todayEvents.map(e =>
    `<tr><td style="padding: 6px 12px; color: ${theme.colors.textMuted}; font-size: 14px; white-space: nowrap; vertical-align: top;">${e.time}</td><td style="padding: 6px 12px; font-size: 14px; color: ${theme.colors.text};">${e.title}</td></tr>`
  ).join('')

  const upcomingRows = upcomingEvents.map(e =>
    `<tr><td style="padding: 6px 12px; color: ${theme.colors.textMuted}; font-size: 14px; white-space: nowrap; vertical-align: top;">${e.date}</td><td style="padding: 6px 12px; font-size: 14px; color: ${theme.colors.text};">${e.time} — ${e.title}</td></tr>`
  ).join('')

  const todoRows = todos.map(t =>
    `<tr><td style="padding: 6px 12px; font-size: 14px; color: ${theme.colors.text};">☐ ${t.title}</td><td style="padding: 6px 12px; color: ${theme.colors.textMuted}; font-size: 13px; white-space: nowrap;">${t.due || ''}</td></tr>`
  ).join('')

  const hasSections = todayEvents.length > 0 || upcomingEvents.length > 0 || todos.length > 0 || commandItems.length > 0

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background-color: ${theme.colors.background}; font-family: 'Inter', system-ui, sans-serif; color: ${theme.colors.text};">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <h1 style="font-size: 24px; margin-bottom: 8px; color: ${theme.colors.text};">${greeting}</h1>
    <p style="color: ${theme.colors.text}; font-size: 16px; line-height: 1.6; margin-bottom: 32px;">${body}</p>

    ${todayEvents.length > 0 ? `
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; font-weight: 600; color: ${theme.colors.textMuted}; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Dnešní program</h2>
      <div style="background-color: ${theme.colors.surface}; border: 1px solid ${theme.colors.border}; border-radius: 8px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${eventRows}</table>
      </div>
    </div>
    ` : ''}

    ${upcomingEvents.length > 0 ? `
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; font-weight: 600; color: ${theme.colors.textMuted}; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Nadcházející dny</h2>
      <div style="background-color: ${theme.colors.surface}; border: 1px solid ${theme.colors.border}; border-radius: 8px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${upcomingRows}</table>
      </div>
    </div>
    ` : ''}

    ${todos.length > 0 ? `
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; font-weight: 600; color: ${theme.colors.textMuted}; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Úkoly</h2>
      <div style="background-color: ${theme.colors.surface}; border: 1px solid ${theme.colors.border}; border-radius: 8px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${todoRows}</table>
      </div>
    </div>
    ` : ''}

    ${commandItems.length > 0 ? `
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; font-weight: 600; color: ${theme.colors.textMuted}; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Zpracované příkazy</h2>
      ${commandItems.map(item => {
        const typeLabel = item.commandType === 'new_contact' ? 'Nový kontakt' : item.commandType === 'todo' ? 'Úkol' : item.commandType
        return `
        <div style="padding: 12px 16px; margin-bottom: 8px; background: ${theme.colors.surface}; border-radius: 8px; border-left: 3px solid ${theme.colors.primary};">
          <div style="font-size: 14px; color: ${theme.colors.text}; font-weight: 500;">${typeLabel}</div>
          <div style="font-size: 13px; color: ${theme.colors.textMuted}; margin-top: 4px;">${item.summary}</div>
        </div>`
      }).join('')}
    </div>
    ` : ''}

    ${!hasSections ? `
    <div style="text-align: center; padding: 32px 0; color: ${theme.colors.textMuted}; font-size: 14px;">
      Žádné schůzky, žádné úkoly. Klidný den.
    </div>
    ` : ''}
  </div>
</body>
</html>`.trim()
}

// ─── Instant High-Priority Notifications ────────────────────────────────────

const INSTANT_NOTIFY_CONCURRENCY = 10
const DEFAULT_INSTANT_URGENCY_THRESHOLD = 9

/**
 * Poll for high-urgency actions and send instant notification emails.
 * Groups actions by CONVERSATION — one email per conversation.
 * Multiple urgent actions from the same email/conversation → one email.
 * Different conversations → separate emails. Never merges across conversations.
 *
 * Uses urgency (AI-assessed immediate pressure, 1-10) instead of
 * priority_score, because priority_score is unreachable on day 0.
 * Sets last_notified_at but keeps queued_for_brief=true so the action
 * still appears in the next morning/afternoon brief if user hasn't acted.
 */
export async function sendInstantNotifications(
  urgencyThreshold: number = DEFAULT_INSTANT_URGENCY_THRESHOLD
): Promise<{ sent: number; failed: number }> {
  const actions = await getHighPriorityUnnotifiedActions(urgencyThreshold)

  if (actions.length === 0) {
    return { sent: 0, failed: 0 }
  }

  console.log(`[InstantNotify] ${actions.length} high-priority action(s)`)

  // Schedule urgent SCHEDULE actions SEQUENTIALLY — each creates a hold on GCal,
  // and the next one must see it to avoid double-booking the same slot.
  // No timeout — a half-finished state (hold on GCal, no payload update) is worse than slow.
  const urgentScheduleActions = actions.filter(a => a.action_type === 'SCHEDULE')
  for (const action of urgentScheduleActions) {
    try {
      const scheduleResult = await scheduleSingleAction(action)
      if (scheduleResult.optimized > 0 || scheduleResult.moveSuggestions.length > 0) {
        console.log(`[InstantNotify] Action ${action.id}: scheduled — ${scheduleResult.moveSuggestions.length} conflicts`)
      }
    } catch (scheduleError) {
      console.error(`[InstantNotify] Action ${action.id}: scheduling failed, continuing:`, scheduleError)
    }
  }

  // Re-fetch actions after scheduling (holds may have been created, payloads updated)
  const updatedActions = urgentScheduleActions.length > 0
    ? await getHighPriorityUnnotifiedActions(urgencyThreshold)
    : actions
  const actionsToSend = updatedActions.length > 0 ? updatedActions : actions

  // Group actions by conversation — one email per conversation
  // Key: "userId:conversationId" to preserve user context
  const byConversation = new Map<string, { userId: string; actions: ActionProposal[] }>()
  for (const action of actionsToSend) {
    const key = `${action.user_id}:${action.conversation_id}`
    const existing = byConversation.get(key)
    if (existing) {
      existing.actions.push(action)
    } else {
      byConversation.set(key, { userId: action.user_id, actions: [action] })
    }
  }

  let sent = 0
  let failed = 0

  const groups = Array.from(byConversation.values())
  for (let i = 0; i < groups.length; i += INSTANT_NOTIFY_CONCURRENCY) {
    const batch = groups.slice(i, i + INSTANT_NOTIFY_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(group => sendInstantNotificationForConversation(group.userId, group.actions))
    )
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        sent++
      } else {
        failed++
      }
    }
  }

  return { sent, failed }
}

/**
 * Send one instant notification email for a single conversation's
 * urgent actions, ordered by urgency (most critical first).
 * One email = one conversation. Never merges across conversations.
 */
async function sendInstantNotificationForConversation(
  userId: string,
  actions: ActionProposal[]
): Promise<boolean> {
  try {
    const user = await getUserById(userId)
    if (!user || !user.email_enabled || user.email_unsubscribed) {
      console.log(`[InstantNotify] User ${userId}: skipped — ${!user ? 'not found' : user.email_unsubscribed ? 'unsubscribed' : 'email disabled'}`)
      return false
    }

    // Critical path ordering: highest urgency first, then by priority_score
    const sorted = [...actions].sort((a, b) => b.urgency - a.urgency || b.priority_score - a.priority_score)

    const briefActions: BriefAction[] = []
    for (const action of sorted) {
      const [cp, conversation] = await Promise.all([
        getCPById(action.cp_id),
        getConversationById(action.conversation_id),
      ])
      if (!cp || !conversation) {
        console.warn(`[InstantNotify] Skipping orphaned action ${action.id}`)
        continue
      }

      const token = generateActionToken(action.id, userId)

      // Conflict resolution URLs (only for SCHEDULE actions with conflicts)
      const instantPayload = action.payload as Record<string, unknown> | null
      const instantUnresolvedConflicts = action.action_type === 'SCHEDULE' && Array.isArray(instantPayload?.conflicts)
        ? (instantPayload!.conflicts as Record<string, unknown>[]).filter(c => !c.resolved)
        : []
      const instantHasConflicts = instantUnresolvedConflicts.length > 0
      const instantFirstIdx = instantHasConflicts
        ? (instantPayload!.conflicts as Record<string, unknown>[]).findIndex(c => !c.resolved)
        : 0

      briefActions.push({
        action,
        cpName: cp.name || cp.primary_identifier,
        cpRole: cp.role || null,
        topic: conversation.topic,
        dealType: conversation.deal_type || null,
        summary: conversation.summary_json as ConversationSummary | null,
        actionUrl: `${APP_BASE_URL}/action/${action.id}?token=${token}&view=details`,
        editUrl: `${APP_BASE_URL}/action/${action.id}/edit?token=${token}`,
        executeUrl: `${APP_BASE_URL}/action/${action.id}?token=${token}&do=execute&type=${action.action_type}`,
        todoUrl: `${APP_BASE_URL}/action/${action.id}?token=${token}&do=todo`,
        blacklistUrl: `${APP_BASE_URL}/action/${action.id}?token=${token}&do=blacklist`,
        resolveRescheduleUrl: instantHasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=reschedule_existing&conflict_idx=${instantFirstIdx}` : null,
        resolveCancelUrl: instantHasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=cancel_existing&conflict_idx=${instantFirstIdx}` : null,
        resolveMoveNewUrl: instantHasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=move_new&conflict_idx=${instantFirstIdx}` : null,
        resolveKeepBothUrl: instantHasConflicts ? `${APP_BASE_URL}/action/${action.id}?token=${token}&do=resolve_conflict&action=keep_both&conflict_idx=${instantFirstIdx}` : null,
      })
    }

    if (briefActions.length === 0) return false

    const topAction = briefActions[0]
    const settings = await getUserSettings(userId)
    let urgentSubject: string
    let urgentHeader: string
    let urgentBody: string
    try {
      const intro = await generateUrgentIntro(
        briefActions.length,
        {
          cpName: topAction.cpName,
          urgency: topAction.action.urgency,
          actionType: topAction.action.action_type,
          intent: topAction.action.intent_cs || topAction.action.rationale_cs || '',
          dollarValue: topAction.action.dollar_value || 0,
        },
        settings
      )
      urgentSubject = intro.subject
      urgentHeader = intro.header
      urgentBody = intro.body
    } catch {
      urgentSubject = `⚡ Mila — ${briefActions.length} urgent`
      urgentHeader = 'Urgent'
      urgentBody = ''
    }

    // Generate AI headlines for urgent actions
    const urgentSettings = await getUserSettings(userId)
    const urgentHeadlineResults = await Promise.allSettled(
      briefActions.map(ba => {
        const p = ba.action.payload as Record<string, unknown> | null
        const holdSlotText = (ba.action.action_type === 'SCHEDULE' && p?.start && p?.end)
          ? formatSlotText(p.start as string, p.end as string) : null
        const daysIgnored = Math.max(0, Math.floor((Date.now() - new Date(ba.action.created_at).getTime()) / 86_400_000))
        return generateBriefHeadline(
          {
            actionType: ba.action.action_type,
            cpName: ba.cpName,
            dealValue: ba.action.dollar_value || 0,
            urgency: ba.action.urgency,
            intent: getActionIntent(ba.action),
            daysSinceContact: daysIgnored,
            holdSlotText,
          },
          ba.summary ? { currentState: ba.summary.currentState, risks: ba.summary.risks, dealType: ba.summary.dealType } : null,
          [],
          urgentSettings
        )
      })
    )

    const urgentHeadlineActions: HeadlineAction[] = briefActions.map((ba, i) => {
      const result = urgentHeadlineResults[i]
      const hl = result.status === 'fulfilled' ? result.value : { headline: ba.cpName, story: ba.action.intent_cs || ba.action.rationale || '' }
      const p = ba.action.payload as Record<string, unknown> | null
      const slotText = (ba.action.action_type === 'SCHEDULE' && p?.start && p?.end)
        ? formatSlotText(p.start as string, p.end as string) : null
      return {
        id: ba.action.id,
        actionType: ba.action.action_type,
        cpName: ba.cpName,
        urgency: ba.action.urgency,
        headline: hl.headline,
        story: hl.story,
        slotText,
      }
    })

    // Persist urgent headlines on actions for web brief page
    await Promise.allSettled(
      urgentHeadlineActions.map(ha => {
        const ba = briefActions.find(b => b.action.id === ha.id)
        if (!ba) return Promise.resolve()
        const existingPayload = (ba.action.payload as Record<string, unknown>) || {}
        return updateAction(ha.id, {
          payload: { ...existingPayload, headline: ha.headline, story: ha.story },
        })
      })
    )

    const urgentTriggerToken = generateTriggerToken(userId)
    const urgentBriefUrl = `${APP_BASE_URL}/brief/${userId}?token=${urgentTriggerToken}`

    const htmlContent = getHeadlineEmailHtml({
      greeting: urgentHeader + (urgentBody ? `\n${urgentBody}` : ''),
      briefUrl: urgentBriefUrl,
      actions: urgentHeadlineActions,
      events: [],
      completed: [],
    })

    const textContent = getHeadlineEmailText({
      greeting: `${urgentHeader}\n${urgentBody}`,
      briefUrl: urgentBriefUrl,
      actions: urgentHeadlineActions,
      events: [],
      completed: [],
    })

    const userEmail = await getUserEmail(userId)

    await sendEmail(userId, {
      to: userEmail,
      subject: urgentSubject,
      body: textContent,
      htmlBody: htmlContent,
    })

    await markActionsInstantNotified(sorted.map(a => a.id))
    console.log(`[InstantNotify] User ${user.email || userId}: sent ${briefActions.length} urgent action(s) in one email`)
    return true
  } catch (error) {
    console.error(`[InstantNotify] User ${userId}: FAILED —`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * HTML email for instant high-priority notifications.
 * Same action cards as morning brief, with an urgent header.
 */
function generateInstantNotifyEmailHtml(actions: BriefAction[], header: string, body: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.colors.background}; font-family: 'Inter', system-ui, sans-serif; color: ${theme.colors.text};">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <h1 style="font-size: 24px; margin-bottom: 8px; color: ${theme.colors.text};">${header}</h1>
    <p style="color: ${theme.colors.textMuted}; font-size: 16px; line-height: 1.5; margin-bottom: 32px;">${body}</p>

    ${actions.map(({ action, cpName, cpRole, topic, summary, actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl, resolveRescheduleUrl, resolveCancelUrl, resolveMoveNewUrl, resolveKeepBothUrl }) => {
      return getActionCardEmailHtml(prepareEmailCardParams(
        action,
        { cpName, cpRole, topic, context: summary?.currentState || null },
        { actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl, resolveRescheduleUrl, resolveCancelUrl, resolveMoveNewUrl, resolveKeepBothUrl },
      ))
    }).join('')}
  </div>
</body>
</html>`.trim()
}

/**
 * Plain text fallback for instant notification email.
 */
function generateInstantNotifyEmailText(actions: BriefAction[], header: string): string {
  let text = `${header}\n\n`
  for (const { action, cpName, cpRole, topic, actionUrl } of actions) {
    const intent = action.intent_cs || action.rationale_cs || action.rationale
    text += `${cpName}${cpRole ? ` · ${cpRole}` : ''}\n`
    text += `${topic}\n`
    text += `Priorita: ${Math.round(action.priority_score)}\n\n`
    text += `${intent}\n\n`
    text += `▸ Detaily / Akce: ${actionUrl}\n`
    text += `------------------------------------------\n\n`
  }
  return text
}
