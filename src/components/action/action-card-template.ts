/**
 * Action Card Template — single source of truth for card data and email HTML.
 *
 * This file has NO 'use client' directive so it can be imported by both:
 *   - ActionCard.tsx (client component, uses TYPE_LABEL / TYPE_VARIANT)
 *   - morning-brief.ts (server service, uses getActionCardEmailHtml)
 */

// ─── Shared Constants ────────────────────────────────────────────────────────

export const TYPE_LABEL: Record<string, string> = {
  REPLY: 'Odpověď', SCHEDULE: 'Schůzka', WAIT: 'Čekat', FILE: 'Úkol', DELEGATE: 'Delegovat', CALL: 'Hovor',
}

export const TYPE_VARIANT: Record<string, 'accent' | 'warning' | 'success' | 'default'> = {
  REPLY: 'accent', SCHEDULE: 'warning', WAIT: 'default', FILE: 'success', DELEGATE: 'warning', CALL: 'accent',
}

// ─── Email Badge Colors ─────────────────────────────────────────────────────
// Solid-color equivalents of the Tailwind rgba badge backgrounds rendered
// over the surface color (#1a2744). Email clients don't support rgba.

const BADGE_EMAIL_COLORS: Record<string, { bg: string; text: string }> = {
  accent:  { bg: '#2a2c43', text: '#8b4d4d' },
  warning: { bg: '#342e35', text: '#facc15' },
  success: { bg: '#18343d', text: '#4ade80' },
  default: { bg: '#1f2d4b', text: '#9ca3af' },
}

// ─── Email HTML Template ─────────────────────────────────────────────────────
// Single source of truth: produces inline-styled HTML matching the React card.
// Used by morning-brief.ts for email rendering.
// Interactive elements become <a> links to the web action page where full
// JS functionality (Details modal, edit panel, blacklist confirm) is available.

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
    <div style="background-color: #1a2744; border: 1px solid #2a3a54; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3), 0 2px 4px -2px rgba(0,0,0,0.2); margin-bottom: 24px; font-family: 'Inter', system-ui, sans-serif;">
      <!-- HEADER -->
      <div style="padding: 20px 24px 12px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align: top;">
              <div style="font-size: 18px; font-weight: 600; color: #e5e7eb; line-height: 1.4;">
                ${cpName}${cpRole ? `<span style="font-size: 14px; font-weight: 400; color: #9ca3af; margin-left: 8px;">&middot; ${cpRole}</span>` : ''}
              </div>
              <div style="font-size: 14px; color: #9ca3af; margin-top: 2px;">${topic}</div>
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
        <p style="font-size: 16px; color: #e5e7eb; line-height: 1.625; margin: 0;">${intent}</p>
      </div>

      <!-- DETAILS LINK -->
      <div style="padding: 0 24px 16px 24px;">
        <a href="${actionUrl}" style="font-size: 14px; color: #9ca3af; text-decoration: none;">&#9656; Detaily</a>
      </div>

      <!-- ACTION CONTROLS -->
      <div style="padding: 16px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <a href="${actionUrl}" style="display: inline-block; padding: 8px 16px; background-color: #6b3d3d; color: white; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none; margin-right: 8px;">UDĚLAT</a>
              <a href="${editUrl}" style="display: inline-block; padding: 8px 16px; background-color: #243352; color: white; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none; margin-right: 8px;">UPRAVIT</a>
              <a href="${actionUrl}" style="display: inline-block; padding: 7px 15px; background-color: transparent; border: 1px solid #2a3a54; color: #e5e7eb; border-radius: 6px; font-weight: 500; font-size: 14px; text-decoration: none;">UDĚLÁM SÁM</a>
            </td>
            <td style="text-align: right; vertical-align: middle;">
              <a href="${actionUrl}" style="font-size: 12px; color: #9ca3af; text-decoration: none;">Zablokovat CP</a>
            </td>
          </tr>
        </table>
      </div>
    </div>
  `
}
