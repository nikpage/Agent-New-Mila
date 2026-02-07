/**
 * Action Card Template — single source of truth for card data and email HTML.
 * Uses the unified Theme configuration for consistent Look & Feel.
 */

import { theme } from '@/config/theme'

// ─── Shared Constants ────────────────────────────────────────────────────────

export const TYPE_LABEL: Record<string, string> = {
  REPLY: 'Odpověď', SCHEDULE: 'Schůzka', WAIT: 'Čekat', FILE: 'Úkol', DELEGATE: 'Delegovat', CALL: 'Hovor',
}

export const TYPE_VARIANT: Record<string, 'accent' | 'warning' | 'success' | 'default'> = {
  REPLY: 'accent', SCHEDULE: 'warning', WAIT: 'default', FILE: 'success', DELEGATE: 'warning', CALL: 'accent',
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
}

export function getActionCardEmailHtml(params: ActionCardEmailParams): string {
  const { cpName, cpRole, topic, actionType, urgency, intent, actionUrl, editUrl } = params

  const typeLabel = TYPE_LABEL[actionType] || actionType
  const typeVariant = TYPE_VARIANT[actionType] || 'default'
  const typeBadge = BADGE_EMAIL_COLORS[typeVariant] || BADGE_EMAIL_COLORS.default
  const urgencyBadge = BADGE_EMAIL_COLORS.accent
  const urgencyLabel = urgency >= 8 ? 'TEĎ' : urgency >= 4 ? 'Zítra' : 'Později'

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
      <div style="padding: 0 24px 16px 24px;">
        <p style="font-size: 16px; color: ${theme.colors.text}; line-height: 1.625; margin: 0;">${intent}</p>
      </div>

      <!-- DETAILS LINK -->
      <div style="padding: 0 24px 16px 24px;">
        <a href="${actionUrl}" style="font-size: 14px; color: ${theme.colors.textMuted}; text-decoration: none;">&#9656; Detaily</a>
      </div>

      <!-- ACTION CONTROLS -->
      <div style="padding: 16px 24px; border-top: 1px solid ${theme.colors.border};">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <a href="${actionUrl}" style="display: inline-block; padding: 8px 16px; background-color: ${theme.colors.primary}; color: white; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none; margin-right: 8px;">UDĚLAT</a>
              <a href="${editUrl}" style="display: inline-block; padding: 8px 16px; background-color: ${theme.colors.secondary}; color: ${theme.colors.text}; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none; margin-right: 8px;">UPRAVIT</a>
              <a href="${actionUrl}" style="display: inline-block; padding: 7px 15px; background-color: transparent; border: 1px solid ${theme.colors.border}; color: ${theme.colors.text}; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none;">UDĚLÁM SÁM</a>
            </td>
            <td style="text-align: right; vertical-align: middle;">
              <a href="${actionUrl}" style="font-size: 12px; color: ${theme.colors.textMuted}; text-decoration: none;">Zablokovat CP</a>
            </td>
          </tr>
        </table>
      </div>
    </div>
  `
}
