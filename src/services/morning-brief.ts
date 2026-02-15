/**
 * Morning Brief Service
 * Generates and sends the daily morning brief email
 */

import { getPendingActionsForBrief, markActionsNotified } from '@/lib/db/actions'
import { getUserById, getUsersWithEmailEnabled, getUserSettings } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getEventsForToday } from '@/lib/db/events'
import { sendEmail, getUserEmail } from '@/lib/google/gmail'
import { generateBriefHeadline } from '@/lib/ai/gemini'
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
}

/**
 * Generate and send morning brief for a user
 */
export async function sendMorningBrief(userId: string): Promise<boolean> {
  try {
    const user = await getUserById(userId)
    if (!user || !user.email_enabled || user.email_unsubscribed) {
      return false
    }

    const actions = await getPendingActionsForBrief(userId)

    if (actions.length === 0) {
      return true
    }

    const events = await getEventsForToday(userId, user.email_timezone)
    const briefActions: BriefAction[] = []

    for (const action of actions.slice(0, 10)) {
      const [cp, conversation] = await Promise.all([
        getCPById(action.cp_id),
        getConversationById(action.conversation_id),
      ])

      if (!cp || !conversation) continue

      const token = generateActionToken(action.id, userId)
      const actionUrl = `${APP_BASE_URL}/action/${action.id}?token=${token}`
      const editUrl = `${APP_BASE_URL}/action/${action.id}/edit?token=${token}`

      briefActions.push({
        action,
        cpName:   cp.name || cp.primary_identifier,
        cpRole:   cp.role || null,
        topic:    conversation.topic,
        dealType: conversation.deal_type || null,
        summary:  conversation.summary_json as ConversationSummary | null,
        actionUrl,
        editUrl,
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

    const htmlContent = generateBriefEmailHtml(headline, briefActions, events.map(e => ({
      title: e.title || 'Event',
      time: new Date(e.start_time).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: user.email_timezone,
      }),
      location: e.location || undefined,
    })))

    const textContent = generateBriefEmailText(headline, briefActions)
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
    return true
  } catch (error) {
    console.error(`[MorningBrief] FAILED for user ${userId}:`, error)
    return false
  }
}

/**
 * Send morning briefs to all enabled users whose local time
 * falls within the 30-minute window of their configured morning_brief_time.
 */
export async function sendAllMorningBriefs(): Promise<{ sent: number; failed: number; skipped: number }> {
  const users = await getUsersWithEmailEnabled()
  let sent = 0
  let failed = 0
  let skipped = 0

  for (const user of users) {
    const settings = await getUserSettings(user.id)

    if (!isTimeForBrief(settings.morning_brief_time, settings.timezone)) {
      skipped++
      continue
    }

    const success = await sendMorningBrief(user.id)
    if (success) {
      sent++
    } else {
      failed++
    }
  }

  return { sent, failed, skipped }
}

/**
 * Check if the current UTC time falls within a 30-minute window
 * of the user's configured morning brief time in their timezone.
 */
function isTimeForBrief(briefTime: string, timezone: string): boolean {
  const now = new Date()
  // Get current time in user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = formatter.formatToParts(now)
  const currentHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
  const currentMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)

  const [targetHour, targetMinute] = briefTime.split(':').map(Number)

  const targetMinutes = targetHour * 60 + targetMinute
  const currentMinutes = currentHour * 60 + currentMinute

  return currentMinutes >= targetMinutes && currentMinutes < targetMinutes + 30
}

/**
 * Generate HTML email content — card rendering delegated to ActionCard.tsx
 */
function generateBriefEmailHtml(
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
    <h1 style="font-size: 24px; margin-bottom: 8px; color: ${theme.colors.text};">Dobré ráno</h1>
    <p style="color: ${theme.colors.textMuted}; font-size: 16px; line-height: 1.5; margin-bottom: 32px;">${headline}</p>

    ${actions.map(({ action, cpName, cpRole, topic, actionUrl, editUrl }) => {
      const missingInfo = (action.missing_info as { label: string; value: string | null }[] | null) || []
      const hasUnfilled = missingInfo.length > 0 && missingInfo.some(f => f.value === null || f.value === '')
      const payload = action.payload as Record<string, unknown> | null
      const hasSlots = !!(payload?.blocked_slots && Array.isArray(payload.blocked_slots) && (payload.blocked_slots as unknown[]).length > 0)
      const needsInput = hasUnfilled && !hasSlots
      return getActionCardEmailHtml({
        cpName,
        cpRole,
        topic,
        actionType: action.action_type,
        urgency: action.urgency,
        intent: action.intent_cs || action.rationale_cs || action.rationale,
        actionUrl,
        editUrl,
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
function generateBriefEmailText(headline: string, actions: BriefAction[]): string {
  let text = `Dobré ráno\n\n${headline}\n\n`;
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
