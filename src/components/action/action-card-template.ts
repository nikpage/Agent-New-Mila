/**
 * Action Card Template — single source of truth for card data and email HTML.
 * Uses the unified Theme configuration for consistent Look & Feel.
 */

import { theme } from '@/config/theme'

/** Enriched conflict data for rendering in action cards and conflict resolution UI */
export interface ConflictCardData {
  [key: string]: string | number | boolean | null | undefined
  event_id: string
  event_title: string
  event_start: string          // ISO
  event_end: string            // ISO
  event_weight: number
  event_score: number
  event_cp_id: string | null
  event_cp_name: string | null
  event_has_guests: boolean
  event_google_id: string | null
  deal_context: string | null
  recommendation: 'move_existing' | 'suggest_alternate'
  alt_slot_start: string | null
  alt_slot_end: string | null
  new_event_score: number
}

// ─── Shared Constants ────────────────────────────────────────────────────────

export const TYPE_LABEL: Record<string, string> = {
  REPLY: 'Odpověď', SCHEDULE: 'Schůzka', TODO: 'Úkol', WAIT: 'Čekat', ARCHIVE: 'Archiv',
}

export const TYPE_VARIANT: Record<string, 'accent' | 'warning' | 'success' | 'default'> = {
  REPLY: 'accent', SCHEDULE: 'warning', TODO: 'success', WAIT: 'default', ARCHIVE: 'default',
}

// ─── Email Badge Colors ─────────────────────────────────────────────────────
// Derived from theme.ts for consistency

const BADGE_EMAIL_COLORS: Record<string, { bg: string; text: string }> = {
  accent:  { bg: '#ffedd5', text: theme.colors.accent },
  warning: { bg: theme.colors.warningBg, text: theme.colors.warning },
  success: { bg: theme.colors.successBg, text: theme.colors.success },
  default: { bg: theme.colors.secondary, text: theme.colors.textMuted },
}

// ─── Email HTML Template ─────────────────────────────────────────────────────

export interface ActionCardEmailParams {
  cpName: string
  cpRole: string | null
  topic: string
  actionType: string
  urgency: number
  intent: string
  actionUrl: string
  editUrl: string
  executeUrl: string
  todoUrl: string
  blacklistUrl: string
  needsInput?: boolean
  location?: string | null
  locationPartial?: boolean
  isOnline?: boolean
  meetingType?: 'address' | 'online' | 'phone'
  cpPhone?: string | null
  slotText?: string | null
  conflicts?: ConflictCardData[]
  /** Resolution button URLs — constructed by morning-brief.ts */
  resolveRescheduleUrl?: string | null
  resolveCancelUrl?: string | null
  resolveMoveNewUrl?: string | null
  /** New action's intent summary (for conflict comparison display) */
  newActionTopic?: string | null
  newActionScore?: number | null
}

/**
 * Convert intent text to HTML with bulleted lists.
 * Lines starting with "N." or "- " become <li> items.
 */
function formatIntentHtml(text: string): string {
  const lines = text.split('\n')
  let html = ''
  let inList = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const isListItem = /^\d+\.\s/.test(trimmed) || trimmed.startsWith('- ')

    if (isListItem) {
      const cleaned = trimmed.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '')
      if (!inList) {
        html += `<ul style="margin: 8px 0; padding-left: 20px;">`
        inList = true
      }
      html += `<li style="margin-bottom: 4px;">${cleaned}</li>`
    } else {
      if (inList) {
        html += `</ul>`
        inList = false
      }
      html += `<p style="margin: 4px 0;">${trimmed}</p>`
    }
  }
  if (inList) html += `</ul>`
  return html
}

export function getActionCardEmailHtml(params: ActionCardEmailParams): string {
  const { cpName, cpRole, topic, actionType, urgency, intent, actionUrl, editUrl, executeUrl, todoUrl, blacklistUrl, needsInput, location, locationPartial, isOnline, meetingType, cpPhone, slotText, conflicts, resolveRescheduleUrl, resolveCancelUrl, resolveMoveNewUrl } = params
  // Resolve effective meeting type: use meetingType if set, fall back to isOnline for backward compat
  const effectiveMeetingType = meetingType || (isOnline ? 'online' : 'address')

  const typeLabel = TYPE_LABEL[actionType] || actionType
  const typeVariant = TYPE_VARIANT[actionType] || 'default'
  const typeBadge = BADGE_EMAIL_COLORS[typeVariant] || BADGE_EMAIL_COLORS.default
  const urgencyBadge = BADGE_EMAIL_COLORS.accent
  const urgencyLabel = urgency >= 8 ? 'TEĎ' : urgency >= 4 ? 'Zítra' : 'Později'

  // UDĚLAT button: grayed out when user needs to fill in info first
  const doItButton = needsInput
    ? `<span style="display: inline-block; padding: 8px 16px; background-color: ${theme.colors.secondary}; color: ${theme.colors.textMuted}; border-radius: 6px; font-weight: 500; font-size: 14px; margin-right: 8px; opacity: 0.5; cursor: not-allowed;">UDĚLAT</span>`
    : `<a href="${executeUrl}" style="display: inline-block; padding: 8px 16px; background-color: ${theme.colors.primary}; color: white; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none; margin-right: 8px;">UDĚLAT</a>`

  return `
    <div style="background-color: ${theme.colors.surface}; border: 1px solid ${theme.colors.border}; border-radius: 8px; box-shadow: 0 1px 3px 0 rgba(0,0,0,0.1); margin-bottom: 24px; font-family: 'Inter', system-ui, sans-serif;">
      <!-- HEADER -->
      <div style="padding: 20px 24px 12px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align: top;">
              <div style="font-size: 18px; font-weight: 600; color: ${theme.colors.text}; line-height: 1.4;">
                ${cpName}${cpRole ? `<span style="font-size: 14px; font-weight: 400; color: ${theme.colors.textMuted}; margin-left: 8px;">&middot; ${cpRole}</span>` : ''}
              </div>
              <div style="font-size: 14px; color: ${theme.colors.textMuted}; margin-top: 2px;">${topic}</div>
            </td>
            <td style="vertical-align: top; text-align: right; white-space: nowrap; padding-left: 16px;">
              <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; background-color: ${typeBadge.bg}; color: ${typeBadge.text};">${typeLabel}</span>
              <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; background-color: ${urgencyBadge.bg}; color: ${urgencyBadge.text}; margin-left: 8px;">${urgencyLabel}</span>
            </td>
          </tr>
        </table>
      </div>

      <!-- INTENT -->
      <div style="padding: 0 24px 16px 24px; font-size: 16px; color: ${theme.colors.text}; line-height: 1.625;">
        ${formatIntentHtml(intent)}
      </div>

      ${actionType === 'SCHEDULE' ? `
      <!-- SCHEDULE METADATA: slot, meeting type, location/phone -->
      <div style="padding: 0 24px 12px 24px; font-size: 14px;">
        ${slotText ? `<span style="color: ${theme.colors.textMuted};">Termín: </span><span style="color: ${theme.colors.text}; font-weight: 500;">${slotText}</span><br/>` : ''}
        ${effectiveMeetingType === 'online'
          ? `<span style="color: ${theme.colors.textMuted};">Typ: </span><span style="color: ${theme.colors.success}; font-weight: 500;">Online (Google Meet)</span>`
          : effectiveMeetingType === 'phone'
            ? `<span style="color: ${theme.colors.textMuted};">Typ: </span><span style="color: ${theme.colors.success}; font-weight: 500;">Telefonát</span>${cpPhone ? `<br/><span style="color: ${theme.colors.textMuted};">Tel: </span><span style="color: ${theme.colors.text}; font-weight: 500;">${cpPhone}</span>` : ''}`
            : `<span style="color: ${theme.colors.textMuted};">Místo: </span>${location
                ? locationPartial
                  ? `<span style="color: ${theme.colors.warning}; font-weight: 500;">${location} — ⚠ upřesněte přes UPRAVIT</span>`
                  : `<span style="color: ${theme.colors.text};">${location}</span>`
                : `<span style="color: ${theme.colors.accent};">Chybí — doplňte přes UPRAVIT</span>`
              }`
        }
      </div>
      ` : ''}

      ${conflicts && conflicts.length > 0 ? `
      <!-- CONFLICT RESOLUTION -->
      ${conflicts.map((c, idx) => {
        const tz = 'Europe/Prague'
        const cStart = new Date(c.event_start)
        const cEnd = new Date(c.event_end)
        const cTimeStr = `${cStart.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })} – ${cEnd.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })}`
        const cDateStr = cStart.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })
        const altTimeStr = c.alt_slot_start ? (() => {
          const altS = new Date(c.alt_slot_start!)
          const altE = c.alt_slot_end ? new Date(c.alt_slot_end) : new Date(altS.getTime() + 30 * 60000)
          return `${altS.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz })}, ${altS.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })} – ${altE.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })}`
        })() : null
        const recText = c.recommendation === 'move_existing'
          ? (altTimeStr ? `Mila doporučuje: přesunout stávající na ${altTimeStr}` : 'Mila doporučuje: přesunout stávající')
          : 'Stávající nelze přesunout — zvažte přesun nové'
        const btnStyle = 'display: inline-block; padding: 6px 12px; border-radius: 6px; font-weight: 500; font-size: 13px; text-decoration: none; margin-right: 6px; margin-top: 6px;'

        return `<div style="margin: 0 24px 12px 24px; padding: 14px 16px; background-color: #fef2f2; border: 2px solid #dc2626; border-radius: 8px;">
        <div style="font-size: 14px; font-weight: 700; color: #dc2626; margin-bottom: 10px;">⚠ KOLIZE V KALENDÁŘI</div>

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 10px;">
          <tr>
            <td style="vertical-align: top; width: 50%; padding-right: 8px;">
              <div style="font-size: 12px; font-weight: 700; color: #991b1b; text-transform: uppercase; margin-bottom: 4px;">Stávající</div>
              <div style="font-size: 14px; color: #1f2937; font-weight: 600;">${c.event_title}</div>
              <div style="font-size: 13px; color: #6b7280;">${cDateStr}, ${cTimeStr}</div>
              ${c.event_cp_name ? `<div style="font-size: 13px; color: #6b7280;">CP: ${c.event_cp_name}</div>` : ''}
              <div style="font-size: 12px; color: #9ca3af; margin-top: 2px;">Váha: ${c.event_weight} | Skóre: ${c.event_score}</div>
              ${c.deal_context ? `<div style="font-size: 12px; color: #6b7280; margin-top: 4px; font-style: italic;">${c.deal_context.slice(0, 120)}${c.deal_context.length > 120 ? '…' : ''}</div>` : '<div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">Žádná konverzace</div>'}
            </td>
            <td style="vertical-align: top; width: 50%; padding-left: 8px;">
              <div style="font-size: 12px; font-weight: 700; color: #1e40af; text-transform: uppercase; margin-bottom: 4px;">Nová (tato)</div>
              <div style="font-size: 14px; color: #1f2937; font-weight: 600;">${cpName} — ${topic}</div>
              ${slotText ? `<div style="font-size: 13px; color: #6b7280;">${slotText}</div>` : ''}
              <div style="font-size: 12px; color: #9ca3af; margin-top: 2px;">Skóre: ${c.new_event_score}</div>
            </td>
          </tr>
        </table>

        <div style="font-size: 13px; color: #991b1b; font-weight: 500; margin-bottom: 8px;">${recText}</div>

        <div>
          ${resolveRescheduleUrl ? `<a href="${resolveRescheduleUrl}" style="${btnStyle} background-color: #dc2626; color: white;">PŘESUNOUT STÁVAJÍCÍ</a>` : ''}
          ${resolveCancelUrl ? `<a href="${resolveCancelUrl}" style="${btnStyle} background-color: #991b1b; color: white;">ZRUŠIT STÁVAJÍCÍ</a>` : ''}
          ${resolveMoveNewUrl ? `<a href="${resolveMoveNewUrl}" style="${btnStyle} background-color: #1e40af; color: white;">PŘESUNOUT NOVOU</a>` : ''}
        </div>
      </div>`
      }).join('')}
      ` : ''}

      <!-- DETAILS LINK -->
      <div style="padding: 0 24px 16px 24px;">
        <a href="${actionUrl}" style="font-size: 14px; color: ${theme.colors.textMuted}; text-decoration: none;">&#9656; Detaily</a>
      </div>

      <!-- ACTION CONTROLS -->
      <div style="padding: 16px 24px; border-top: 1px solid ${theme.colors.border};">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              ${doItButton}
              <a href="${editUrl}" style="display: inline-block; padding: 8px 16px; background-color: ${needsInput ? theme.colors.primary : theme.colors.secondary}; color: ${needsInput ? 'white' : theme.colors.text}; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none; margin-right: 8px;">UPRAVIT</a>
              <a href="${todoUrl}" style="display: inline-block; padding: 7px 15px; background-color: transparent; border: 1px solid ${theme.colors.border}; color: ${theme.colors.text}; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none;">UDĚLÁM SÁM</a>
            </td>
            <td style="text-align: right; vertical-align: middle;">
              <a href="${blacklistUrl}" style="font-size: 12px; color: ${theme.colors.textMuted}; text-decoration: none;">Zablokovat CP</a>
            </td>
          </tr>
        </table>
      </div>
    </div>
  `
}
