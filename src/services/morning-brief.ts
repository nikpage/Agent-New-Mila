import { getPendingActionsForBrief, markActionsNotified } from '@/lib/db/actions'
import { getUserById, getUsersWithEmailEnabled } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { getConversationById } from '@/lib/db/conversations'
import { getEventsForToday } from '@/lib/db/events'
import { sendEmail, getUserEmail } from '@/lib/google/gmail'
import { generateBriefHeadline } from '@/lib/ai/gemini'
import { generateActionToken } from '@/lib/auth/tokens'
import { getActionCardTemplate } from '@/components/action/ActionCard'

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000'

export async function sendMorningBrief(userId: string): Promise<boolean> {
  try {
    const user = await getUserById(userId)
    if (!user || !user.email_enabled || user.email_unsubscribed) return false
    const actions = await getPendingActionsForBrief(userId)
    if (actions.length === 0) return true
    const events = await getEventsForToday(userId, user.email_timezone)

    const briefActions = await Promise.all(actions.slice(0, 10).map(async action => {
      const [cp, conversation] = await Promise.all([getCPById(action.cp_id), getConversationById(action.conversation_id)])
      if (!cp || !conversation) return null
      const token = generateActionToken(action.id, userId)
      return { action, cp, conversation, actionUrl: `${APP_BASE_URL}/action/${action.id}?token=${token}`, editUrl: `${APP_BASE_URL}/action/${action.id}/edit?token=${token}` }
    }))

    const validActions = briefActions.filter((a): a is NonNullable<typeof a> => a !== null)
    const headline = await generateBriefHeadline(events.map(e => ({ title: e.title || 'Event', time: new Date(e.start_time).toLocaleTimeString() })), validActions.map(v => ({ type: v.action.action_type, cpName: v.cp.name || v.cp.primary_identifier, urgency: v.action.urgency })))

    const htmlContent = `
      <!DOCTYPE html><html><body style="margin:0;padding:40px 20px;background-color:#F9F7F2;font-family:sans-serif;color:#1A2744;">
        <h1 style="font-size:24px;margin-bottom:8px;">Dobré ráno</h1>
        <p style="color:#64748B;font-size:16px;line-height:1.5;margin-bottom:32px;">${headline}</p>
        ${validActions.map(v => getActionCardTemplate({
          cpName: v.cp.name || v.cp.primary_identifier,
          cpRole: v.cp.role,
          topic: v.conversation.topic,
          typeLabel: v.action.action_type,
          urgencyLabel: v.action.urgency >= 8 ? 'TEĎ' : 'Později',
          intent: v.action.intent_cs || v.action.rationale_cs || v.action.rationale,
          actionUrl: v.actionUrl,
          editUrl: v.editUrl,
          isEmail: true
        })).join('')}
      </body></html>`

    await sendEmail(userId, { to: await getUserEmail(userId), subject: `Mila: ${validActions.length} actions`, body: headline, htmlBody: htmlContent })
    await markActionsNotified(validActions.map(v => v.action.id))
    return true
  } catch (error) { return false }
}

export async function sendAllMorningBriefs() {
  const users = await getUsersWithEmailEnabled()
  for (const user of users) await sendMorningBrief(user.id)
}
