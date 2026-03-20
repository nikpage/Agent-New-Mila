/**
 * Morning Brief Service
 * Generates and sends the daily morning brief email
 */

import { getPendingActionsForBrief, markActionsNotified, getHighPriorityUnnotifiedActions, markActionsInstantNotified } from '@/lib/db/actions'
import { getUserById, getUsersDueBrief, getUserSettings } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getEventsForToday } from '@/lib/db/events'
import { sendEmail, getUserEmail } from '@/lib/google/gmail'
import { generateBriefIntro, generateUrgentIntro } from '@/lib/ai/mila-voice'
import { optimizeScheduleActions, scheduleSingleAction } from '@/services/scheduling'
import { generateActionToken } from '@/lib/auth/tokens'
import { getActionCardEmailHtml } from '../components/action/action-card-template';
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
    console.log(`[Brief] User ${user.email || userId}: ${actions.length} pending actions`)

    if (actions.length === 0) {
      console.log(`[Brief] User ${user.email || userId}: nothing to send`)
      return true
    }

    const events = await getEventsForToday(userId, user.email_timezone)
    console.log(`[Brief] User ${user.email || userId}: ${events.length} events today`)
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
      })
    }

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

    const htmlContent = generateBriefEmailHtml(userId, greeting, headline, briefActions, events.map(e => ({
      title: e.title || 'Event',
      time: new Date(e.start_time).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: user.email_timezone,
      }),
      location: e.location || undefined,
    })))

    const textContent = generateBriefEmailText(greeting, headline, briefActions)
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
  events: { title: string; time: string; location?: string }[]
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

    ${actions.map(({ action, cpName, cpRole, topic, actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl }) => {
      const payload = action.payload as Record<string, unknown> | null
      const payloadLocation = payload?.location as string | null
      const isOnline = !!payload?.is_online
      const locationPartial = !!payload?.location_partial
      let needsInput = false
      if (action.action_type === 'SCHEDULE') {
        const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
        const hasUnfilled = missingInfo.length > 0 && missingInfo.some(f => f.value === null || f.value === '')
        const hasHold = !!payload?.hold_event_id
        const hasUnfilledLocation = !isOnline && (
          !payloadLocation
            ? missingInfo.some(f => (f.value === null || f.value === '') && f.label.includes('adresa'))
            : locationPartial
        )
        needsInput = hasUnfilledLocation || (hasUnfilled && !hasHold)
      }
      const location = payloadLocation || null
      return getActionCardEmailHtml({
        cpName,
        cpRole,
        topic,
        actionType: action.action_type,
        urgency: action.urgency,
        intent: action.intent_cs || action.rationale_cs || action.rationale,
        actionUrl,
        editUrl,
        executeUrl,
        todoUrl,
        blacklistUrl,
        needsInput,
        location,
        locationPartial,
        isOnline,
      })
    }).join('')}
  </div>
</body>
</html>`.trim()
}

/**
 * Generate plain text email content
 */
function generateBriefEmailText(greeting: string, headline: string, actions: BriefAction[]): string {
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
  return text;
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

    const htmlContent = generateInstantNotifyEmailHtml(briefActions, urgentHeader, urgentBody)
    const textContent = generateInstantNotifyEmailText(briefActions, urgentHeader)
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

    ${actions.map(({ action, cpName, cpRole, topic, actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl }) => {
      const payload = action.payload as Record<string, unknown> | null
      const payloadLocation = payload?.location as string | null
      const isOnline = !!payload?.is_online
      const locationPartial = !!payload?.location_partial
      let needsInput = false
      if (action.action_type === 'SCHEDULE') {
        const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
        const hasUnfilled = missingInfo.length > 0 && missingInfo.some(f => f.value === null || f.value === '')
        const hasHold = !!payload?.hold_event_id
        const hasUnfilledLocation = !isOnline && (
          !payloadLocation
            ? missingInfo.some(f => (f.value === null || f.value === '') && f.label.includes('adresa'))
            : locationPartial
        )
        needsInput = hasUnfilledLocation || (hasUnfilled && !hasHold)
      }
      const location = payloadLocation || null
      return getActionCardEmailHtml({
        cpName,
        cpRole,
        topic,
        actionType: action.action_type,
        urgency: action.urgency,
        intent: action.intent_cs || action.rationale_cs || action.rationale,
        actionUrl,
        editUrl,
        executeUrl,
        todoUrl,
        blacklistUrl,
        needsInput,
        location,
        locationPartial,
        isOnline,
      })
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
