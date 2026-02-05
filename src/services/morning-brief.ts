/**
 * Morning Brief Service
 * Generates and sends the daily morning brief email
 */

import { getPendingActionsForBrief, markActionsNotified } from '@/lib/db/actions'
import { getUserById, getUsersWithEmailEnabled } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getEventsForToday } from '@/lib/db/events'
import { sendEmail, getUserEmail } from '@/lib/google/gmail'
import { generateBriefHeadline } from '@/lib/ai/gemini'
import { generateActionToken } from '@/lib/auth/tokens'
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

      briefActions.push({
        action,
        cpName:   cp.name || cp.primary_identifier,
        cpRole:   cp.role || null,
        topic:    conversation.topic,
        dealType: conversation.deal_type || null,
        summary:  conversation.summary_json as ConversationSummary | null,
        actionUrl,
      })
    }

    const headline = await generateBriefHeadline(
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

    await sendEmail(userId, {
      to: userEmail,
      subject: `Mila: ${briefActions.length} proposed actions`,
      body: textContent,
      htmlBody: htmlContent,
    })

    await markActionsNotified(briefActions.map(b => b.action.id))
    return true
  } catch (error) {
    console.error(`Failed to send morning brief for user ${userId}:`, error)
    return false
  }
}

/**
 * Send morning briefs to all enabled users
 */
export async function sendAllMorningBriefs(): Promise<{ sent: number; failed: number }> {
  const users = await getUsersWithEmailEnabled()
  let sent = 0
  let failed = 0

  for (const user of users) {
    const success = await sendMorningBrief(user.id)
    if (success) {
      sent++
    } else {
      failed++
    }
  }

  return { sent, failed }
}

/**
 * Generate HTML email content strictly following the Wireframe Spec
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
  <style>
    body { margin: 0; padding: 0; background-color: #0f1623; font-family: sans-serif; color: #e5e7eb; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    .card { background-color: #1a2744; border: 1px solid #2a3a54; border-radius: 8px; padding: 24px; margin-bottom: 24px; }
    .priority-label { text-align: center; color: #9ca3af; font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 2px; }
    .priority-value { text-align: center; font-size: 48px; font-weight: bold; color: #e5e7eb; margin: 8px 0 24px 0; }
    .intent { font-size: 16px; line-height: 1.5; color: #e5e7eb; margin-bottom: 16px; }
    .details-link { font-size: 14px; color: #9ca3af; text-decoration: none; display: block; margin-bottom: 24px; }
    .cta-btn { display: inline-block; padding: 12px 24px; background-color: #6b3d3d; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; margin-right: 8px; }
    .badge { display: inline-block; padding: 2px 8px; background-color: #2a3a54; color: #9ca3af; font-size: 11px; border-radius: 4px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1 style="font-size: 24px; margin-bottom: 8px;">Good morning</h1>
    <p style="color: #9ca3af; font-size: 16px; line-height: 1.5; margin-bottom: 32px;">${headline}</p>

    ${actions.map(({ action, cpName, cpRole, topic, actionUrl }) => {
      const intent = (action.payload as any)?.original_proposal?.proposedResponse || action.rationale;
      return `
      <div class="card">
        <div style="font-weight: 600; font-size: 18px;">${cpName}${cpRole ? ` <span style="font-weight: 400; color: #9ca3af; font-size: 14px;">· ${cpRole}</span>` : ''}</div>
        <div style="color: #9ca3af; font-size: 14px; margin-top: 4px; margin-bottom: 16px;">${topic}</div>

        <div class="badge">${action.action_type}</div>

        <div class="priority-label">Priority</div>
        <div class="priority-value">${Math.round(action.priority_score)}</div>

        <div class="intent">${intent}</div>

        <a href="${actionUrl}" class="details-link">▸ Details</a>

        <div>
          <a href="${actionUrl}" class="cta-btn">DO IT</a>
          <a href="${actionUrl}" class="cta-btn" style="background-color: #243352;">EDIT</a>
          <a href="${actionUrl}" class="cta-btn" style="background-color: transparent; border: 1px solid #2a3a54;">I'LL DO IT</a>
        </div>
      </div>
      `
    }).join('')}
  </div>
</body>
</html>`.trim()
}

/**
 * Generate plain text email content
 */
function generateBriefEmailText(headline: string, actions: BriefAction[]): string {
  let text = `Good morning\n\n${headline}\n\n`;
  for (const { action, cpName, cpRole, topic, actionUrl } of actions) {
    const intent = (action.payload as any)?.original_proposal?.proposedResponse || action.rationale;
    text += `${cpName}${cpRole ? ` · ${cpRole}` : ''}\n`;
    text += `${topic}\n`;
    text += `Priority: ${Math.round(action.priority_score)}\n\n`;
    text += `${intent}\n\n`;
    text += `▸ Details / Actions: ${actionUrl}\n`;
    text += `------------------------------------------\n\n`;
  }
  return text;
}
