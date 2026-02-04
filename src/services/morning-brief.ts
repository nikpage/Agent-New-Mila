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

function getUrgency(score: number): { label: string; bg: string; color: string } {
  if (score >= 80) return { label: 'NOW',      bg: '#c0392b', color: '#ffffff' }
  if (score >= 40) return { label: 'TODAY',    bg: '#e67e22', color: '#ffffff' }
  if (score >= 15) return { label: 'TOMORROW', bg: '#f39c12', color: '#ffffff' }
  return                   { label: 'SOON',    bg: '#2a3a54', color: '#9ca3af' }
}

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

    // Get pending actions
    const actions = await getPendingActionsForBrief(userId)

    if (actions.length === 0) {
      // No actions to report
      return true
    }

    // Get today's events
    const events = await getEventsForToday(userId, user.email_timezone)

    // Enrich actions with CP and conversation info
    const briefActions: BriefAction[] = []

    for (const action of actions.slice(0, 10)) { // Limit to top 10
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

    // Generate headline
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

    // Generate email HTML
    const htmlContent = generateBriefEmailHtml(headline, briefActions, events.map(e => ({
      title: e.title || 'Event',
      time: new Date(e.start_time).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: user.email_timezone,
      }),
      location: e.location || undefined,
    })))

    // Generate plain text version
    const textContent = generateBriefEmailText(headline, briefActions)

    // Send email (to self)
    const userEmail = await getUserEmail(userId)

    await sendEmail(userId, {
      to: userEmail,
      subject: `Mila: ${briefActions.length} items need your attention`,
      body: textContent,
      htmlBody: htmlContent,
    })

    // Mark actions as notified
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
 * Generate HTML email content
 */
function generateBriefEmailHtml(
  headline: string,
  actions: BriefAction[],
  events: { title: string; time: string; location?: string }[]
): string {
  const actionTypeLabels: Record<string, string> = {
    REPLY: 'Reply',
    SCHEDULE: 'Schedule',
    WAIT: 'Waiting',
    FILE: 'Archive',
    DELEGATE: 'Delegate',
  }

  const actionTypeColors: Record<string, string> = {
    REPLY: '#6b3d3d',
    SCHEDULE: '#8b6914',
    WAIT: '#4a5568',
    FILE: '#2d6a4f',
    DELEGATE: '#8b6914',
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mila Morning Brief</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f1623; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0f1623;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px;">

          <!-- Header -->
          <tr>
            <td style="padding-bottom: 24px;">
              <h1 style="margin: 0; color: #e5e7eb; font-size: 24px; font-weight: 600;">Good morning</h1>
              <p style="margin: 8px 0 0; color: #9ca3af; font-size: 16px; line-height: 1.5;">${headline}</p>
            </td>
          </tr>

          ${events.length > 0 ? `
          <!-- Today's Schedule -->
          <tr>
            <td style="padding-bottom: 24px;">
              <h2 style="margin: 0 0 12px; color: #9ca3af; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Today's Schedule</h2>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #1a2744; border-radius: 8px;">
                ${events.map(event => `
                <tr>
                  <td style="padding: 12px 16px; border-bottom: 1px solid #2a3a54;">
                    <span style="color: #6b3d3d; font-weight: 500;">${event.time}</span>
                    <span style="color: #e5e7eb; margin-left: 12px;">${event.title}</span>
                    ${event.location ? `<span style="color: #9ca3af; margin-left: 8px; font-size: 14px;">${event.location}</span>` : ''}
                  </td>
                </tr>
                `).join('')}
              </table>
            </td>
          </tr>
          ` : ''}

          <!-- Action Cards -->
          <tr>
            <td>
              <h2 style="margin: 0 0 12px; color: #9ca3af; font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;">Needs Your Attention</h2>

              ${actions.map(({ action, cpName, cpRole, topic, dealType, summary, actionUrl }) => {
                const urgency = getUrgency(action.priority_score)
                const adjValue = action.dollar_value * (action.offer_multiplier ?? 1)
                const proposedResponse = (action.payload as { original_proposal?: { proposedResponse?: string } })?.original_proposal?.proposedResponse
                return `
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #1a2744; border-radius: 8px; margin-bottom: 12px;">
                <tr>
                  <td style="padding: 20px;">

                    <!-- Badge + Urgency row -->
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                      <tr>
                        <td>
                          <span style="display: inline-block; padding: 4px 10px; background-color: ${actionTypeColors[action.action_type] || '#4a5568'}; color: white; font-size: 12px; font-weight: 600; border-radius: 4px;">${actionTypeLabels[action.action_type] || action.action_type}</span>
                        </td>
                        <td align="right">
                          <span style="display: inline-block; padding: 3px 8px; background-color: ${urgency.bg}; color: ${urgency.color}; font-size: 11px; font-weight: 700; border-radius: 3px; letter-spacing: 0.08em;">${urgency.label}</span>
                        </td>
                      </tr>
                    </table>

                    <!-- CP name · role -->
                    <h3 style="margin: 14px 0 2px; color: #e5e7eb; font-size: 18px; font-weight: 600;">${cpName}${cpRole ? `<span style="font-size: 13px; font-weight: 400; color: #9ca3af; margin-left: 6px;">· ${cpRole}</span>` : ''}</h3>

                    <!-- Deal type · topic -->
                    <p style="margin: 0 0 14px; color: #9ca3af; font-size: 13px;">${dealType ? `${dealType} · ` : ''}${topic}</p>

                    <!-- Priority (large) -->
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 14px;">
                      <tr>
                        <td style="width: 72px; vertical-align: middle;">
                          <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                            <tr>
                              <td align="center" style="width: 64px; height: 64px; background-color: #0f1623; border-radius: 10px;">
                                <span style="font-size: 28px; font-weight: 700; color: #e5e7eb; line-height: 64px;">${Math.round(action.priority_score)}</span>
                              </td>
                            </tr>
                          </table>
                        </td>
                        <td style="padding-left: 16px; vertical-align: middle;">
                          <span style="color: #6b7280; font-size: 11px;">Value: </span><span style="color: #e5e7eb; font-size: 11px; font-weight: 600;">$${adjValue.toLocaleString()}</span><br>
                          <span style="color: #6b7280; font-size: 11px;">Urgency: </span><span style="color: #e5e7eb; font-size: 11px; font-weight: 600;">${action.urgency}/10</span><span style="color: #6b7280; font-size: 11px; margin-left: 12px;">Pain: </span><span style="color: #e5e7eb; font-size: 11px; font-weight: 600;">${action.pain_factor}/10</span>
                        </td>
                      </tr>
                    </table>

                    <!-- Why now (rationale) -->
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 10px;">
                      <tr>
                        <td style="padding: 10px 12px; background-color: #0f1623; border-radius: 6px;">
                          <p style="margin: 0 0 4px; color: #6b7280; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;">Why now</p>
                          <p style="margin: 0; color: #e5e7eb; font-size: 13px; line-height: 1.5;">${action.rationale}</p>
                        </td>
                      </tr>
                    </table>

                    <!-- Conversation snapshot -->
                    ${summary ? `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 12px;">
                      <tr>
                        <td style="padding: 10px 12px; background-color: #122038; border-radius: 6px;">
                          <p style="margin: 0 0 6px; color: #6b7280; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;">Conversation snapshot</p>
                          <p style="margin: 0 0 3px; color: #c0c8d4; font-size: 12px;"><span style="color: #9ca3af;">State:</span> ${summary.currentState || ''}</p>
                          ${summary.risks && summary.risks.length > 0 ? `<p style="margin: 3px 0; color: #c0c8d4; font-size: 12px;"><span style="color: #c0392b;">Risk:</span> ${summary.risks.join(' · ')}</p>` : ''}
                          ${summary.nextSteps && summary.nextSteps.length > 0 ? `<p style="margin: 3px 0 0; color: #c0c8d4; font-size: 12px;"><span style="color: #27ae60;">Next:</span> ${summary.nextSteps.join(' · ')}</p>` : ''}
                        </td>
                      </tr>
                    </table>
                    ` : ''}

                    <!-- Mila's Proposed Response -->
                    ${proposedResponse ? `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 10px;">
                      <tr>
                        <td style="padding: 10px 12px; background-color: #132540; border: 1px solid #2a3a54; border-radius: 6px;">
                          <p style="margin: 0 0 4px; color: #6b7280; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;">Mila's proposed response</p>
                          <p style="margin: 0; color: #e5e7eb; font-size: 13px; line-height: 1.5;">${proposedResponse}</p>
                        </td>
                      </tr>
                    </table>
                    ` : ''}

                    <!-- Draft preview (if available) -->
                    ${action.draft_body_text ? `
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 14px;">
                      <tr>
                        <td style="padding: 10px 12px; background-color: #152033; border: 1px solid #2a3a54; border-radius: 6px;">
                          <p style="margin: 0 0 4px; color: #6b7280; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;">Draft</p>
                          ${action.draft_subject ? `<p style="margin: 0 0 3px; color: #e5e7eb; font-size: 13px; font-weight: 600;">${action.draft_subject}</p>` : ''}
                          <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.4;">${action.draft_body_text.slice(0, 200)}${action.draft_body_text.length > 200 ? '…' : ''}</p>
                        </td>
                      </tr>
                    </table>
                    ` : ''}

                    <!-- CTA Button -->
                    <a href="${actionUrl}" style="display: inline-block; padding: 10px 22px; background-color: #6b3d3d; color: white; text-decoration: none; font-weight: 600; border-radius: 6px; font-size: 14px;">View &amp; Respond</a>
                  </td>
                </tr>
              </table>
              `
              }).join('')}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p style="margin: 0; color: #6b7280; font-size: 12px;">
                Sent by Mila, your AI executive assistant
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

/**
 * Generate plain text email content
 */
function generateBriefEmailText(headline: string, actions: BriefAction[]): string {
  const actionTypeLabels: Record<string, string> = {
    REPLY: 'Reply',
    SCHEDULE: 'Schedule',
    WAIT: 'Waiting',
    FILE: 'Archive',
    DELEGATE: 'Delegate',
  }

  let text = `Good morning\n\n${headline}\n\n`
  text += `NEEDS YOUR ATTENTION\n${'='.repeat(40)}\n\n`

  for (const { action, cpName, cpRole, topic, dealType, summary, actionUrl } of actions) {
    const urgency = getUrgency(action.priority_score)
    const proposedResponse = (action.payload as { original_proposal?: { proposedResponse?: string } })?.original_proposal?.proposedResponse

    text += `[${actionTypeLabels[action.action_type] || action.action_type}] ${cpName}${cpRole ? ` · ${cpRole}` : ''}  [${urgency.label}]\n`
    text += dealType ? `Deal: ${dealType} · ${topic}\n` : `Topic: ${topic}\n`
    text += `Priority: ${Math.round(action.priority_score)}\n\n`
    text += `Why now: ${action.rationale}\n\n`

    if (summary) {
      text += `State: ${summary.currentState}\n`
      if (summary.risks && summary.risks.length > 0) text += `Risk: ${summary.risks.join(' · ')}\n`
      if (summary.nextSteps && summary.nextSteps.length > 0) text += `Next: ${summary.nextSteps.join(' · ')}\n`
      text += '\n'
    }

    if (proposedResponse) {
      text += `Mila's proposed response:\n${proposedResponse}\n\n`
    }

    if (action.draft_body_text) {
      text += `Draft:\n`
      if (action.draft_subject) text += `Subject: ${action.draft_subject}\n`
      text += `${action.draft_body_text.slice(0, 200)}${action.draft_body_text.length > 200 ? '…' : ''}\n\n`
    }

    text += `View & Respond: ${actionUrl}\n`
    text += `${'-'.repeat(40)}\n\n`
  }

  text += `\nSent by Mila, your AI executive assistant`

  return text
}
