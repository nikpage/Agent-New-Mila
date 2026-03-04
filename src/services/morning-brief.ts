/**
 * Morning Brief Service
 * Generates and sends the daily morning brief email
 */

import { getPendingActionsForBrief, markActionsNotified, getHighPriorityUnnotifiedActions, markActionsInstantNotified } from '@/lib/db/actions'
import { getUserById, getUsersDueBrief } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getEventsForToday } from '@/lib/db/events'
import { sendEmail, getUserEmail } from '@/lib/google/gmail'
import { generateBriefHeadline } from '@/lib/ai/gemini'
import { generateActionToken, generateTriggerToken } from '@/lib/auth/tokens'
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
      const executeUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&do=execute`
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

    let headline: string
    try {
      headline = await generateBriefHeadline(
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
        }))
      )
    } catch (headlineError) {
      console.error(`[MorningBrief] Headline generation failed for user ${userId}, using fallback:`, headlineError)
      headline = `Máte ${briefActions.length} akčních návrhů ke zpracování.`
    }

    const greeting = briefType === 'morning' ? 'Dobré ráno' : 'Dobré odpoledne'

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


    const subjectCount = briefActions.length
    const subjectText = subjectCount === 1 ? 'navrhovaná akce' : subjectCount <= 4 ? 'navrhované akce' : 'navrhovaných akcí'

    await sendEmail(userId, {
      to: userEmail,
      subject: `Mila: ${subjectCount} ${subjectText}`,
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
  const triggerSig = generateTriggerToken(userId)
  const triggerUrl = `${APP_BASE_URL}/api/trigger/ingest?uid=${userId}&sig=${triggerSig}`
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.colors.background}; font-family: 'Inter', system-ui, sans-serif; color: ${theme.colors.text};">
  <img src="${triggerUrl}" width="1" height="1" style="display:none" alt="" />
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <h1 style="font-size: 24px; margin-bottom: 8px; color: ${theme.colors.text};">${greeting}</h1>
    <p style="color: ${theme.colors.textMuted}; font-size: 16px; line-height: 1.5; margin-bottom: 32px;">${headline}</p>

    ${actions.map(({ action, cpName, cpRole, topic, actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl }) => {
      const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
      const hasUnfilled = missingInfo.length > 0 && missingInfo.some(f => f.value === null || f.value === '')
      const payload = action.payload as Record<string, unknown> | null
      const hasHold = !!payload?.hold_event_id
      const needsInput = hasUnfilled && !hasHold
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
const DEFAULT_INSTANT_THRESHOLD = 79

/**
 * Poll for high-priority actions and send instant notification emails.
 * Sets last_notified_at but keeps queued_for_brief=true so the action
 * still appears in the next morning/afternoon brief if user hasn't acted.
 */
export async function sendInstantNotifications(
  threshold: number = DEFAULT_INSTANT_THRESHOLD
): Promise<{ sent: number; failed: number }> {
  const actions = await getHighPriorityUnnotifiedActions(threshold)

  if (actions.length === 0) {
    return { sent: 0, failed: 0 }
  }

  // Group actions by user_id
  const byUser = new Map<string, typeof actions>()
  for (const action of actions) {
    const list = byUser.get(action.user_id) || []
    list.push(action)
    byUser.set(action.user_id, list)
  }

  console.log(`[InstantNotify] ${actions.length} high-priority action(s) for ${byUser.size} user(s)`)

  let sent = 0
  let failed = 0
  const userIds = Array.from(byUser.keys())

  for (let i = 0; i < userIds.length; i += INSTANT_NOTIFY_CONCURRENCY) {
    const batch = userIds.slice(i, i + INSTANT_NOTIFY_CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(userId => sendInstantNotificationForUser(userId, byUser.get(userId)!))
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
 * Send an instant notification email for one user with their high-priority actions.
 */
async function sendInstantNotificationForUser(
  userId: string,
  actions: ActionProposal[]
): Promise<boolean> {
  try {
    const user = await getUserById(userId)
    if (!user || !user.email_enabled || user.email_unsubscribed) {
      console.log(`[InstantNotify] User ${userId}: skipped — ${!user ? 'not found' : user.email_unsubscribed ? 'unsubscribed' : 'email disabled'}`)
      return false
    }

    const briefActions: BriefAction[] = []

    for (const action of actions) {
      const [cp, conversation] = await Promise.all([
        getCPById(action.cp_id),
        getConversationById(action.conversation_id),
      ])

      if (!cp || !conversation) {
        console.warn(`[InstantNotify] Skipping orphaned action ${action.id}`)
        continue
      }

      const token = generateActionToken(action.id, userId)
      const actionUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&view=details`
      const editUrl = `${APP_BASE_URL}/action/${action.id}/edit?token=${token}`
      const executeUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&do=execute`
      const todoUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&do=todo`
      const blacklistUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}&do=blacklist`

      briefActions.push({
        action,
        cpName: cp.name || cp.primary_identifier,
        cpRole: cp.role || null,
        topic: conversation.topic,
        dealType: conversation.deal_type || null,
        summary: conversation.summary_json as ConversationSummary | null,
        actionUrl,
        editUrl,
        executeUrl,
        todoUrl,
        blacklistUrl,
      })
    }

    if (briefActions.length === 0) return false

    const htmlContent = generateInstantNotifyEmailHtml(briefActions)
    const textContent = generateInstantNotifyEmailText(briefActions)
    const userEmail = await getUserEmail(userId)

    const count = briefActions.length
    const subject = count === 1
      ? `⚡ Mila: urgentní akce`
      : `⚡ Mila: ${count} urgentní akce`

    await sendEmail(userId, {
      to: userEmail,
      subject,
      body: textContent,
      htmlBody: htmlContent,
    })

    // Mark as instant-notified (keeps queued_for_brief = true)
    await markActionsInstantNotified(briefActions.map(b => b.action.id))
    console.log(`[InstantNotify] User ${user.email || userId}: sent ${briefActions.length} urgent action(s)`)
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
function generateInstantNotifyEmailHtml(actions: BriefAction[]): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.colors.background}; font-family: 'Inter', system-ui, sans-serif; color: ${theme.colors.text};">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <h1 style="font-size: 24px; margin-bottom: 8px; color: ${theme.colors.text};">⚡ Urgentní akce</h1>
    <p style="color: ${theme.colors.textMuted}; font-size: 16px; line-height: 1.5; margin-bottom: 32px;">Máte ${actions.length === 1 ? 'novou vysoce prioritní akci' : `${actions.length} nové vysoce prioritní akce`} k okamžitému zpracování.</p>

    ${actions.map(({ action, cpName, cpRole, topic, actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl }) => {
      const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
      const hasUnfilled = missingInfo.length > 0 && missingInfo.some(f => f.value === null || f.value === '')
      const payload = action.payload as Record<string, unknown> | null
      const hasHold = !!payload?.hold_event_id
      const needsInput = hasUnfilled && !hasHold
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
      })
    }).join('')}
  </div>
</body>
</html>`.trim()
}

/**
 * Plain text fallback for instant notification email.
 */
function generateInstantNotifyEmailText(actions: BriefAction[]): string {
  let text = `⚡ URGENTNÍ AKCE\n\n`
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
