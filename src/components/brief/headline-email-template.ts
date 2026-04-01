/**
 * Headline-style email template for the new brief format.
 * Renders scannable headline stories, not interactive cards.
 * Each headline links to the web brief page.
 *
 * Does NOT modify action-card-template.ts — this is a parallel system.
 */

import { theme } from '@/config/theme'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HeadlineAction {
  id: string
  actionType: string
  cpName: string
  urgency: number
  headline: string
  story: string
  /** Hold slot text for SCHEDULE actions */
  slotText?: string | null
}

export interface HeadlineEvent {
  title: string
  time: string
  location?: string | null
  isHold?: boolean
}

export interface HeadlineCompleted {
  cpName: string
  actionType: string
  topic?: string | null
}

export interface HeadlineEmailParams {
  greeting: string
  briefUrl: string
  actions: HeadlineAction[]
  events: HeadlineEvent[]
  completed: HeadlineCompleted[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUrgencySignal(urgency: number): string {
  if (urgency >= 10) return '🔥🔥🔥 '
  if (urgency >= 9) return '🔥 '
  return ''
}

const TYPE_LABEL: Record<string, string> = {
  REPLY: 'Odpověď', SCHEDULE: 'Schůzka', TODO: 'Úkol',
}

// ─── Template ─────────────────────────────────────────────────────────────────

export function getHeadlineEmailHtml(params: HeadlineEmailParams): string {
  const { greeting, briefUrl, actions, events, completed } = params

  const actionsHtml = actions.map(action => {
    const signal = getUrgencySignal(action.urgency)
    const actionUrl = `${briefUrl}#action-${action.id}`

    return `
      <tr>
        <td style="padding: 16px 0; border-bottom: 1px solid ${theme.colors.border};">
          <a href="${actionUrl}" style="text-decoration: none; display: block;">
            <div style="font-size: 17px; font-weight: 600; color: ${theme.colors.text}; line-height: 1.4; margin-bottom: 4px;">
              ${signal}${escapeHtml(action.headline)}
            </div>
            <div style="font-size: 15px; color: ${theme.colors.textMuted}; line-height: 1.55;">
              ${escapeHtml(action.story)}
            </div>
            ${action.slotText ? `<div style="font-size: 13px; color: ${theme.colors.text}; margin-top: 6px; font-weight: 500;">${escapeHtml(action.slotText)}</div>` : ''}
          </a>
        </td>
      </tr>`
  }).join('')

  const eventsHtml = events.length > 0 ? `
    <tr>
      <td style="padding: 24px 0 12px 0;">
        <div style="font-size: 12px; font-weight: 600; color: ${theme.colors.textMuted}; text-transform: uppercase; letter-spacing: 0.05em;">
          Kalendář
        </div>
      </td>
    </tr>
    ${events.map(event => `
      <tr>
        <td style="padding: 6px 0; font-size: 14px;">
          <span style="color: ${theme.colors.text}; font-weight: 500; font-variant-numeric: tabular-nums;">${escapeHtml(event.time)}</span>
          <span style="color: ${theme.colors.textMuted};"> · </span>
          <span style="color: ${theme.colors.text};">${escapeHtml(event.title)}</span>
          ${event.isHold ? `<span style="font-size: 12px; color: ${theme.colors.warning}; font-style: italic; margin-left: 6px;">čeká na potvrzení</span>` : ''}
          ${event.location ? `<span style="color: ${theme.colors.textMuted};"> · ${escapeHtml(event.location)}</span>` : ''}
        </td>
      </tr>
    `).join('')}` : ''

  const completedHtml = completed.length > 0 ? `
    <tr>
      <td style="padding: 24px 0 12px 0;">
        <div style="font-size: 12px; font-weight: 600; color: ${theme.colors.textMuted}; text-transform: uppercase; letter-spacing: 0.05em;">
          Mila vyřídila
        </div>
      </td>
    </tr>
    ${completed.map(item => `
      <tr>
        <td style="padding: 4px 0; font-size: 13px; color: ${theme.colors.textMuted};">
          <span style="color: ${theme.colors.success};">✓</span>
          ${escapeHtml(item.cpName)} · ${TYPE_LABEL[item.actionType] || item.actionType}${item.topic ? ` · ${escapeHtml(item.topic)}` : ''}
        </td>
      </tr>
    `).join('')}` : ''

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mila Brief</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${theme.colors.background}; font-family: 'Inter', system-ui, -apple-system, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${theme.colors.background};">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: ${theme.colors.surface}; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="padding: 28px 28px 8px 28px;">
              <!-- Greeting -->
              <div style="font-size: 15px; color: ${theme.colors.textMuted}; line-height: 1.5; margin-bottom: 8px;">
                ${escapeHtml(greeting)}
              </div>
              <!-- Open in Mila link -->
              <a href="${briefUrl}" style="font-size: 13px; color: ${theme.colors.primary}; text-decoration: none; font-weight: 500;">
                Otevřít v Míle →
              </a>
            </td>
          </tr>

          <!-- Action headlines -->
          <tr>
            <td style="padding: 8px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${actionsHtml}
              </table>
            </td>
          </tr>

          <!-- Calendar -->
          <tr>
            <td style="padding: 0 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${eventsHtml}
              </table>
            </td>
          </tr>

          <!-- Completed -->
          <tr>
            <td style="padding: 0 28px 28px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${completedHtml}
              </table>
            </td>
          </tr>
        </table>

        <!-- Footer -->
        <div style="margin-top: 16px; font-size: 11px; color: ${theme.colors.textMuted}; text-align: center;">
          Mila · Special Agents
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** Generate plain-text version of the brief email */
export function getHeadlineEmailText(params: HeadlineEmailParams): string {
  const { greeting, briefUrl, actions, events, completed } = params
  let text = `${greeting}\n\nOtevřít v Míle: ${briefUrl}\n\n`

  for (const action of actions) {
    const signal = getUrgencySignal(action.urgency)
    text += `${signal}${action.headline}\n${action.story}\n`
    if (action.slotText) text += `${action.slotText}\n`
    text += `→ ${briefUrl}#action-${action.id}\n\n`
  }

  if (events.length > 0) {
    text += `─── Kalendář ───\n`
    for (const event of events) {
      text += `${event.time} · ${event.title}${event.isHold ? ' (čeká na potvrzení)' : ''}${event.location ? ` · ${event.location}` : ''}\n`
    }
    text += '\n'
  }

  if (completed.length > 0) {
    text += `─── Mila vyřídila ───\n`
    for (const item of completed) {
      text += `✓ ${item.cpName} · ${TYPE_LABEL[item.actionType] || item.actionType}${item.topic ? ` · ${item.topic}` : ''}\n`
    }
  }

  return text
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
