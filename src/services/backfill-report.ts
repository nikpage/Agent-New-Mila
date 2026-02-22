/**
 * Backfill Report Service
 *
 * Generates and sends a "Welcome to Mila" report email after bulk ingestion.
 * The report summarizes what Mila found during historical backfill:
 *   - Inbox health snapshot (totals, inbound/outbound)
 *   - Filtered spam/automated emails (with "Allow as Contact" links)
 *   - Counterparties discovered (with message counts, deal stage, blacklist links)
 *   - Conversation threads (with suggested next steps, "Add to Mila" links)
 *   - Lead tracking (cooling/cold/dead leads)
 *   - Unanswered inbound emails (last 7 days)
 *   - Calendar events (next 2 weeks)
 *
 * Email is sent from the user's own Gmail to themselves.
 */

import { getUserById, getUserSettings } from '@/lib/db/users'
import { getCPsForUser, normalizeGmailAddress } from '@/lib/db/counterparties'
import { getConversationsForUser, getRecentMessages } from '@/lib/db/conversations'
import { getUpcomingEvents } from '@/lib/db/events'
import { sendEmail, getUserEmail } from '@/lib/google/gmail'
import { generateBackfillToken } from '@/lib/auth/tokens'
import { getLeadStatus } from './lead-tracking'
import type { LeadStatus } from './lead-tracking'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import { theme } from '@/config/theme'
import type { BulkIngestionPhase1Result, FilteredSender } from './bulk-ingestion'

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000'

// ─── Data Types ─────────────────────────────────────────────────────────────

interface ReportCP {
  id: string
  name: string
  email: string
  role: string | null
  messageCount: number
  leadStatus: LeadStatus
}

interface ReportConversation {
  id: string
  topic: string
  cpNames: string[]
  primaryCpId: string | null
  messageCount: number
  lastActivity: Date
  leadStatus: LeadStatus
  summaryText: string | null
  lastInboundUnanswered: boolean
}

interface ReportLead {
  conversationId: string
  topic: string
  cpName: string
  daysSilent: number
  status: LeadStatus
}

interface ReportEvent {
  title: string
  date: string     // formatted: "Mon Feb 23"
  time: string     // formatted: "09:00–10:00"
  location: string | null
}

interface BackfillReportData {
  userName: string
  phase1: BulkIngestionPhase1Result
  filteredSenders: FilteredSender[]
  counterparties: ReportCP[]
  conversations: ReportConversation[]
  leads: { cooling: ReportLead[]; cold: ReportLead[]; dead: ReportLead[] }
  unanswered: ReportConversation[]
  events: ReportEvent[]
  dateRange: { since: Date; until: Date }
}

// ─── Data Gathering ─────────────────────────────────────────────────────────

/**
 * Gather all data needed for the backfill report.
 */
async function gatherReportData(
  userId: string,
  phase1: BulkIngestionPhase1Result,
  filteredSenders: FilteredSender[],
  since: Date,
  until: Date
): Promise<BackfillReportData> {
  const [user, settings] = await Promise.all([
    getUserById(userId),
    getUserSettings(userId),
  ])

  const userName = user?.mila_name || user?.public_name || settings.user_alias || 'User'

  // Parallel: CPs, conversations, calendar events
  const [allCPs, allConversations, calendarEvents] = await Promise.all([
    getCPsForUser(userId),
    getConversationsForUser(userId, { orderBy: 'last_updated' }),
    getUpcomingEvents(userId, 14),
  ])

  // Get message counts per CP via single query
  const cpMessageCounts = await getMessageCountsPerCP(userId)

  // Build a set of CP emails for deduplication against filtered senders
  const cpEmails = new Set(allCPs.map(cp => normalizeGmailAddress(cp.primary_identifier)))

  // Build CP report data with lead status
  const counterparties: ReportCP[] = allCPs
    .map(cp => {
      const count = cpMessageCounts.get(cp.id) || 0
      // Approximate lead status from last conversation activity for this CP
      return {
        id: cp.id,
        name: cp.name || cp.primary_identifier,
        email: cp.primary_identifier,
        role: cp.role || null,
        messageCount: count,
        leadStatus: 'active' as LeadStatus,
      }
    })
    .sort((a, b) => b.messageCount - a.messageCount)

  // Build conversation data with lead status
  const conversations: ReportConversation[] = []
  const leads: BackfillReportData['leads'] = { cooling: [], cold: [], dead: [] }
  const unanswered: ReportConversation[] = []

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // Process conversations in batches to get recent messages
  const BATCH = 10
  for (let i = 0; i < allConversations.length; i += BATCH) {
    const batch = allConversations.slice(i, i + BATCH)
    const batchResults = await Promise.allSettled(
      batch.map(async conv => {
        const messages = await getRecentMessages(conv.id, 5)
        const lastMsg = messages[messages.length - 1]
        const lastActivity = conv.last_updated
          ? new Date(conv.last_updated)
          : conv.created_at ? new Date(conv.created_at) : new Date()
        const daysSince = Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
        const status = getLeadStatus(daysSince, settings)

        // Determine if last message is unanswered inbound
        const lastInboundUnanswered = !!(
          lastMsg &&
          lastMsg.direction === 'inbound' &&
          new Date(lastMsg.timestamp) >= sevenDaysAgo
        )

        // Get unique CP names from messages
        const cpIds = new Set(messages.filter(m => m.cp_id).map(m => m.cp_id!))
        const matchedCPs = allCPs.filter(cp => cpIds.has(cp.id))
        const cpNames = matchedCPs.map(cp => cp.name || cp.primary_identifier)
        const primaryCpId = matchedCPs[0]?.id || null

        const convData: ReportConversation = {
          id: conv.id,
          topic: conv.topic || 'Bez tématu',
          cpNames,
          primaryCpId,
          messageCount: conv.message_count || messages.length,
          lastActivity,
          leadStatus: status,
          summaryText: conv.summary_text || null,
          lastInboundUnanswered,
        }

        conversations.push(convData)

        // Categorize leads
        if (status !== 'active') {
          const leadData: ReportLead = {
            conversationId: conv.id,
            topic: conv.topic || 'Bez tématu',
            cpName: cpNames[0] || 'Neznámý',
            daysSilent: daysSince,
            status,
          }
          if (status === 'cooling') leads.cooling.push(leadData)
          if (status === 'cold') leads.cold.push(leadData)
          if (status === 'dead') leads.dead.push(leadData)
        }

        // Track unanswered
        if (lastInboundUnanswered) {
          unanswered.push(convData)
        }

        // Update CP lead status
        if (lastMsg?.cp_id) {
          const cpEntry = counterparties.find(cp => cp.id === lastMsg.cp_id)
          if (cpEntry && status !== 'active') {
            cpEntry.leadStatus = status
          }
        }
      })
    )

    for (const r of batchResults) {
      if (r.status === 'rejected') {
        console.error('[BackfillReport] Conversation processing error:', r.reason)
      }
    }
  }

  // Sort conversations by message count desc
  conversations.sort((a, b) => b.messageCount - a.messageCount)
  unanswered.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())

  // Format calendar events
  const timezone = settings.timezone || 'Europe/Prague'
  const events: ReportEvent[] = calendarEvents.map(e => ({
    title: e.title || 'Událost',
    date: new Date(e.start_time).toLocaleDateString('cs-CZ', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: timezone,
    }),
    time: `${new Date(e.start_time).toLocaleTimeString('cs-CZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    })}–${new Date(e.end_time).toLocaleTimeString('cs-CZ', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    })}`,
    location: e.location || null,
  }))

  // Dedup: remove filtered senders that are already known CPs
  const dedupedFiltered = filteredSenders.filter(
    s => !cpEmails.has(normalizeGmailAddress(s.email))
  )

  return {
    userName,
    phase1,
    filteredSenders: dedupedFiltered,
    counterparties,
    conversations,
    leads,
    unanswered,
    events,
    dateRange: { since, until },
  }
}

/**
 * Get message counts grouped by cp_id for a user.
 */
async function getMessageCountsPerCP(userId: string): Promise<Map<string, number>> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('messages')
    .select('cp_id')
    .eq('user_id', userId)
    .not('cp_id', 'is', null)

  if (error || !data) return new Map()

  const counts = new Map<string, number>()
  for (const row of data) {
    if (row.cp_id) {
      counts.set(row.cp_id, (counts.get(row.cp_id) || 0) + 1)
    }
  }
  return counts
}

// ─── URL Helpers ────────────────────────────────────────────────────────────

function allowUrl(userId: string, email: string): string {
  // Sign with raw email — browser auto-decodes %40→@ from query params,
  // so the token must match the decoded value.
  const sig = generateBackfillToken(userId, 'allow', email)
  return `${APP_BASE_URL}/api/backfill/action?uid=${userId}&op=allow&target=${encodeURIComponent(email)}&sig=${sig}`
}

function blacklistUrl(userId: string, cpId: string): string {
  const sig = generateBackfillToken(userId, 'blacklist', cpId)
  return `${APP_BASE_URL}/api/backfill/action?uid=${userId}&op=blacklist&target=${cpId}&sig=${sig}`
}

function addToMilaUrl(userId: string, conversationId: string): string {
  const sig = generateBackfillToken(userId, 'add', conversationId)
  return `${APP_BASE_URL}/api/backfill/action?uid=${userId}&op=add&target=${conversationId}&sig=${sig}`
}

function setRoleUrl(userId: string, cpId: string, role: string): string {
  const target = `${cpId}:${role}`
  const sig = generateBackfillToken(userId, 'setrole', target)
  return `${APP_BASE_URL}/api/backfill/action?uid=${userId}&op=setrole&target=${encodeURIComponent(target)}&sig=${sig}`
}

// ─── HTML Generation ────────────────────────────────────────────────────────

const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  active: 'Aktivní',
  cooling: 'Chladne',
  cold: 'Studený',
  dead: 'Neaktivní',
}

const CP_ROLE_LABELS: Record<string, string> = {
  buyer: 'kupující',
  seller: 'prodávající',
  tenant: 'nájemce',
  agent: 'makléř',
  other: 'jiný',
}

const QUICK_ROLES = ['buyer', 'seller', 'tenant', 'agent', 'other'] as const

const LEAD_STATUS_COLORS: Record<LeadStatus, string> = {
  active: theme.colors.success,
  cooling: theme.colors.warning,
  cold: theme.colors.accent,
  dead: theme.colors.error,
}

function sectionHeading(title: string): string {
  return `
    <tr><td style="padding: 32px 0 12px 0;">
      <h2 style="font-size: 20px; margin: 0; color: ${theme.colors.text}; border-bottom: 2px solid ${theme.colors.border}; padding-bottom: 8px;">${title}</h2>
    </td></tr>`
}

function badge(label: string, color: string, bg?: string): string {
  const bgColor = bg || (color + '18') // approximate light background
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;background-color:${bgColor};color:${color};">${label}</span>`
}

function linkButton(href: string, label: string, primary: boolean = false): string {
  const bg = primary ? theme.colors.primary : theme.colors.secondary
  const color = primary ? '#ffffff' : theme.colors.text
  return `<a href="${href}" style="display:inline-block;padding:6px 14px;background-color:${bg};color:${color};border-radius:6px;font-weight:500;font-size:13px;text-decoration:none;margin-right:6px;">${label}</a>`
}

function generateReportHtml(userId: string, data: BackfillReportData): string {
  const { userName, phase1, filteredSenders, counterparties, conversations, leads, unanswered, events, dateRange } = data

  const totalFiltered = phase1.skippedBlocked + phase1.skippedPreFilter + phase1.skippedCategory
  const sinceStr = dateRange.since.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' })
  const untilStr = dateRange.until.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' })

  let html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:${theme.colors.background};font-family:'Inter',system-ui,sans-serif;color:${theme.colors.text};">
<div style="max-width:640px;margin:0 auto;padding:40px 20px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">

  <!-- Greeting -->
  <tr><td>
    <h1 style="font-size:26px;margin:0 0 8px 0;color:${theme.colors.text};">Ahoj ${userName},</h1>
    <p style="font-size:16px;color:${theme.colors.textMuted};line-height:1.5;margin:0 0 8px 0;">
      Jsem Mila, vaše nová asistentka. Prošla jsem vaši poštu za období <strong>${sinceStr} – ${untilStr}</strong> a připravila jsem pro vás přehled.
    </p>
  </td></tr>`

  // ── Inbox Snapshot ──────────────────────────────────────────────────────
  html += sectionHeading('Přehled schránky')
  html += `<tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:8px;overflow:hidden;">
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid ${theme.colors.border};">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-size:14px;color:${theme.colors.textMuted};">Emailů zpracováno</td><td style="text-align:right;font-size:18px;font-weight:600;">${phase1.inboxFetched + phase1.sentFetched}</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 20px;border-bottom:1px solid ${theme.colors.border};">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-size:14px;color:${theme.colors.textMuted};">Příchozí</td><td style="text-align:right;font-weight:500;">${phase1.inboxFetched}</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 20px;border-bottom:1px solid ${theme.colors.border};">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-size:14px;color:${theme.colors.textMuted};">Odchozí</td><td style="text-align:right;font-weight:500;">${phase1.sentFetched}</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 20px;border-bottom:1px solid ${theme.colors.border};">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-size:14px;color:${theme.colors.textMuted};">Uloženo a zařazeno</td><td style="text-align:right;font-weight:500;">${phase1.stored}</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 20px;border-bottom:1px solid ${theme.colors.border};">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-size:14px;color:${theme.colors.textMuted};">Spam / automatické odfiltrováno</td><td style="text-align:right;font-weight:500;">${totalFiltered}</td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-size:14px;color:${theme.colors.textMuted};">Konverzací vytvořeno</td><td style="text-align:right;font-weight:500;">${conversations.length}</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </td></tr>`

  // ── Filtered Emails ─────────────────────────────────────────────────────
  if (filteredSenders.length > 0) {
    html += sectionHeading(`Odfiltrované emaily (${totalFiltered})`)
    html += `<tr><td>
      <p style="font-size:14px;color:${theme.colors.textMuted};margin:0 0 12px 0;">
        Tyto adresy vypadaly jako spam nebo automatické notifikace. Pokud je některý skutečný kontakt, klikněte na <strong>Povolit</strong>.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:8px;overflow:hidden;">`

    const showMax = 15
    const shown = filteredSenders.slice(0, showMax)
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i]
      const borderStyle = i < shown.length - 1 ? `border-bottom:1px solid ${theme.colors.border};` : ''
      html += `<tr><td style="padding:10px 16px;${borderStyle}">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-size:14px;">
              <strong>${escapeHtml(s.email)}</strong>
              <span style="color:${theme.colors.textMuted};margin-left:8px;">${s.count}x</span>
              <span style="color:${theme.colors.textMuted};margin-left:8px;font-size:12px;">${escapeHtml(s.reason)}</span>
            </td>
            <td style="text-align:right;white-space:nowrap;">
              ${linkButton(allowUrl(userId, s.email), 'Povolit')}
            </td>
          </tr>
        </table>
      </td></tr>`
    }

    if (filteredSenders.length > showMax) {
      html += `<tr><td style="padding:10px 16px;text-align:center;font-size:13px;color:${theme.colors.textMuted};">
        ...a ${filteredSenders.length - showMax} dalších odesílatelů
      </td></tr>`
    }

    html += `</table></td></tr>`
  }

  // ── Counterparties ──────────────────────────────────────────────────────
  if (counterparties.length > 0) {
    html += sectionHeading(`Nalezené kontakty (${counterparties.length})`)
    html += `<tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:8px;overflow:hidden;">
        <tr style="background:${theme.colors.secondary};">
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};">KONTAKT</td>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};text-align:center;">ZPRÁVY</td>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};text-align:center;">ROLE</td>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};text-align:right;"></td>
        </tr>`

    const showCPs = counterparties.slice(0, 20)
    for (let i = 0; i < showCPs.length; i++) {
      const cp = showCPs[i]
      const borderStyle = i < showCPs.length - 1 ? `border-bottom:1px solid ${theme.colors.border};` : ''
      // Show role name if set, otherwise show quick-set links
      const roleCell = cp.role
        ? `<span style="font-size:13px;">${CP_ROLE_LABELS[cp.role] || cp.role}</span>`
        : QUICK_ROLES.map(r =>
            `<a href="${setRoleUrl(userId, cp.id, r)}" style="font-size:11px;color:${theme.colors.primaryLight};text-decoration:none;padding:1px 4px;">${CP_ROLE_LABELS[r]}</a>`
          ).join('<span style="color:${theme.colors.border};">·</span>')
      html += `<tr>
        <td style="padding:10px 12px;${borderStyle}">
          <div style="font-size:14px;font-weight:500;">${escapeHtml(cp.name)}</div>
          <div style="font-size:12px;color:${theme.colors.textMuted};">${escapeHtml(cp.email)}</div>
        </td>
        <td style="padding:10px 12px;${borderStyle}text-align:center;font-weight:500;">${cp.messageCount}</td>
        <td style="padding:10px 12px;${borderStyle}text-align:center;">${roleCell}</td>
        <td style="padding:10px 12px;${borderStyle}text-align:right;">
          <a href="${blacklistUrl(userId, cp.id)}" style="font-size:12px;color:${theme.colors.textMuted};text-decoration:none;">Zablokovat</a>
        </td>
      </tr>`
    }

    if (counterparties.length > 20) {
      html += `<tr><td colspan="4" style="padding:10px 12px;text-align:center;font-size:13px;color:${theme.colors.textMuted};">
        ...a ${counterparties.length - 20} dalších kontaktů
      </td></tr>`
    }

    html += `</table></td></tr>`
  }

  // ── Conversations ───────────────────────────────────────────────────────
  if (conversations.length > 0) {
    const showConvs = conversations.slice(0, 15)
    html += sectionHeading(`Konverzace (${conversations.length})`)
    html += `<tr><td>
      <p style="font-size:14px;color:${theme.colors.textMuted};margin:0 0 12px 0;">
        Vaše emaily jsem seskupila do konverzací. U každé navrhuji další krok. Klikněte <strong>Přidat do Mila</strong>, pokud chcete, abych se o konverzaci starala.
      </p>
    </td></tr>`

    for (const conv of showConvs) {
      const ago = Math.floor((Date.now() - conv.lastActivity.getTime()) / (1000 * 60 * 60 * 24))
      const agoText = ago === 0 ? 'dnes' : ago === 1 ? 'včera' : `před ${ago} dny`
      const stopFollowLink = conv.primaryCpId
        ? `<a href="${blacklistUrl(userId, conv.primaryCpId)}" style="font-size:12px;color:${theme.colors.textMuted};text-decoration:none;margin-left:12px;">Přestat sledovat</a>`
        : ''
      html += `<tr><td style="padding-bottom:16px;">
        <div style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:8px;overflow:hidden;">
          <div style="padding:16px 20px 8px 20px;">
            <div style="font-size:16px;font-weight:600;color:${theme.colors.text};">${escapeHtml(conv.topic)}</div>
            <div style="font-size:13px;color:${theme.colors.textMuted};margin-top:2px;">
              ${escapeHtml(conv.cpNames.join(', '))} &middot; ${conv.messageCount} zpráv &middot; ${agoText}
            </div>
          </div>
          ${conv.summaryText ? `<div style="padding:4px 20px 12px 20px;font-size:14px;color:${theme.colors.textMuted};line-height:1.5;">${escapeHtml(conv.summaryText)}</div>` : ''}
          <div style="padding:12px 20px;border-top:1px solid ${theme.colors.border};">
            ${linkButton(addToMilaUrl(userId, conv.id), 'Přidat do Mila', true)}${stopFollowLink}
          </div>
        </div>
      </td></tr>`
    }

    if (conversations.length > 15) {
      html += `<tr><td style="text-align:center;padding:8px 0;font-size:13px;color:${theme.colors.textMuted};">
        ...a ${conversations.length - 15} dalších konverzací
      </td></tr>`
    }
  }

  // ── Lead Tracking ───────────────────────────────────────────────────────
  const totalLeads = leads.cooling.length + leads.cold.length + leads.dead.length
  if (totalLeads > 0) {
    html += sectionHeading('Sledování leadů')
    html += `<tr><td>
      <p style="font-size:14px;color:${theme.colors.textMuted};margin:0 0 12px 0;">
        Některé konverzace ztrácí tempo. Pokud chcete, abych se o ně postarala, přidejte je do Mila.
      </p>
    </td></tr>`

    const renderLeadGroup = (title: string, items: ReportLead[], color: string) => {
      if (items.length === 0) return ''
      let groupHtml = `<tr><td style="padding-bottom:12px;">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">${title} (${items.length})</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:8px;overflow:hidden;">`

      for (let i = 0; i < Math.min(items.length, 8); i++) {
        const lead = items[i]
        const borderStyle = i < Math.min(items.length, 8) - 1 ? `border-bottom:1px solid ${theme.colors.border};` : ''
        groupHtml += `<tr>
          <td style="padding:10px 14px;${borderStyle}">
            <div style="font-size:14px;font-weight:500;">${escapeHtml(lead.topic)}</div>
            <div style="font-size:12px;color:${theme.colors.textMuted};">${escapeHtml(lead.cpName)} &middot; ${lead.daysSilent} dní bez odpovědi</div>
          </td>
          <td style="padding:10px 14px;${borderStyle}text-align:right;white-space:nowrap;">
            ${linkButton(addToMilaUrl(userId, lead.conversationId), 'Přidat do Mila', true)}
          </td>
        </tr>`
      }

      if (items.length > 8) {
        groupHtml += `<tr><td colspan="2" style="padding:8px 14px;text-align:center;font-size:13px;color:${theme.colors.textMuted};">
          ...a ${items.length - 8} dalších
        </td></tr>`
      }

      groupHtml += `</table></td></tr>`
      return groupHtml
    }

    html += renderLeadGroup(`Chladnoucí (${data.leads.cooling[0]?.daysSilent || '2'}–${data.leads.cooling[data.leads.cooling.length - 1]?.daysSilent || '5'} dní)`, leads.cooling, theme.colors.warning)
    html += renderLeadGroup(`Studené (${data.leads.cold[0]?.daysSilent || '5'}–${data.leads.cold[data.leads.cold.length - 1]?.daysSilent || '14'} dní)`, leads.cold, theme.colors.accent)
    html += renderLeadGroup(`Neaktivní (${data.leads.dead[0]?.daysSilent || '14'}+ dní)`, leads.dead, theme.colors.error)
  }

  // ── Unanswered Inbound ──────────────────────────────────────────────────
  if (unanswered.length > 0) {
    html += sectionHeading(`Nezodpovězené příchozí (posledních 7 dní)`)
    html += `<tr><td>
      <p style="font-size:14px;color:${theme.colors.textMuted};margin:0 0 12px 0;">
        Tyto konverzace čekají na vaši odpověď. Přidáním do Mila vám navrhnu odpověď.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:8px;overflow:hidden;">`

    for (let i = 0; i < Math.min(unanswered.length, 10); i++) {
      const conv = unanswered[i]
      const ago = Math.floor((Date.now() - conv.lastActivity.getTime()) / (1000 * 60 * 60 * 24))
      const agoText = ago === 0 ? 'dnes' : ago === 1 ? 'včera' : `před ${ago} dny`
      const borderStyle = i < Math.min(unanswered.length, 10) - 1 ? `border-bottom:1px solid ${theme.colors.border};` : ''
      html += `<tr>
        <td style="padding:10px 14px;${borderStyle}">
          <div style="font-size:14px;font-weight:500;">${escapeHtml(conv.topic)}</div>
          <div style="font-size:12px;color:${theme.colors.textMuted};">${escapeHtml(conv.cpNames.join(', '))} &middot; ${agoText}</div>
        </td>
        <td style="padding:10px 14px;${borderStyle}text-align:right;white-space:nowrap;">
          ${linkButton(addToMilaUrl(userId, conv.id), 'Přidat do Mila', true)}
        </td>
      </tr>`
    }

    html += `</table></td></tr>`
  }

  // ── Calendar ────────────────────────────────────────────────────────────
  if (events.length > 0) {
    html += sectionHeading('Kalendář — příštích 14 dní')
    html += `<tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.colors.surface};border:1px solid ${theme.colors.border};border-radius:8px;overflow:hidden;">
        <tr style="background:${theme.colors.secondary};">
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};">DATUM</td>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};">ČAS</td>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};">UDÁLOST</td>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:${theme.colors.textMuted};">MÍSTO</td>
        </tr>`

    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      const borderStyle = i < events.length - 1 ? `border-bottom:1px solid ${theme.colors.border};` : ''
      html += `<tr>
        <td style="padding:8px 12px;${borderStyle}font-size:13px;white-space:nowrap;">${escapeHtml(e.date)}</td>
        <td style="padding:8px 12px;${borderStyle}font-size:13px;white-space:nowrap;">${escapeHtml(e.time)}</td>
        <td style="padding:8px 12px;${borderStyle}font-size:13px;font-weight:500;">${escapeHtml(e.title)}</td>
        <td style="padding:8px 12px;${borderStyle}font-size:13px;color:${theme.colors.textMuted};">${e.location ? escapeHtml(e.location) : '—'}</td>
      </tr>`
    }

    html += `</table></td></tr>`
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  html += `
  <tr><td style="padding:32px 0 0 0;">
    <div style="border-top:2px solid ${theme.colors.border};padding-top:24px;">
      <h3 style="font-size:18px;margin:0 0 12px 0;color:${theme.colors.text};">Co bude dál?</h3>
      <ul style="margin:0;padding-left:20px;font-size:14px;color:${theme.colors.textMuted};line-height:1.8;">
        <li>Konverzace označené <strong>Přidat do Mila</strong> začnu sledovat, navrhnu odpovědi a zahrnu je do vašich briefů.</li>
        <li>Povolené kontakty zpracuji při příštím spuštění.</li>
        <li>Zablokované kontakty budu ignorovat.</li>
      </ul>
      <p style="font-size:14px;color:${theme.colors.textMuted};margin-top:16px;">
        Váš první <strong>ranní brief</strong> dorazí zítra v ${data.userName === 'User' ? '08:00' : '08:00'}. Najdete v něm akce pro konverzace, které jste přidali do mého procesu.
      </p>
      <p style="font-size:16px;margin-top:24px;color:${theme.colors.text};">— Mila</p>
    </div>
  </td></tr>

</table>
</div>
</body>
</html>`

  return html
}

// ─── Plain Text Generation ──────────────────────────────────────────────────

function generateReportText(data: BackfillReportData): string {
  const { userName, phase1, filteredSenders, counterparties, conversations, leads, unanswered, events, dateRange } = data
  const totalFiltered = phase1.skippedBlocked + phase1.skippedPreFilter + phase1.skippedCategory

  let text = `Ahoj ${userName},\n\n`
  text += `Jsem Mila, vaše nová asistentka. Prošla jsem vaši poštu a připravila přehled.\n\n`

  text += `═══ PŘEHLED SCHRÁNKY ═══\n`
  text += `Emailů zpracováno: ${phase1.inboxFetched + phase1.sentFetched}\n`
  text += `Příchozí: ${phase1.inboxFetched} | Odchozí: ${phase1.sentFetched}\n`
  text += `Uloženo: ${phase1.stored} | Odfiltrováno: ${totalFiltered}\n`
  text += `Konverzací: ${conversations.length} | Kontaktů: ${counterparties.length}\n\n`

  if (filteredSenders.length > 0) {
    text += `═══ ODFILTROVANÉ (${totalFiltered}) ═══\n`
    for (const s of filteredSenders.slice(0, 15)) {
      text += `  ${s.email} (${s.count}x) — ${s.reason}\n`
    }
    text += '\n'
  }

  if (counterparties.length > 0) {
    text += `═══ KONTAKTY (${counterparties.length}) ═══\n`
    for (const cp of counterparties.slice(0, 20)) {
      text += `  ${cp.name} <${cp.email}> — ${cp.messageCount} zpráv — ${LEAD_STATUS_LABELS[cp.leadStatus]}\n`
    }
    text += '\n'
  }

  const totalLeads = leads.cooling.length + leads.cold.length + leads.dead.length
  if (totalLeads > 0) {
    text += `═══ SLEDOVÁNÍ LEADŮ ═══\n`
    for (const lead of [...leads.dead, ...leads.cold, ...leads.cooling].slice(0, 15)) {
      text += `  ${lead.topic} — ${lead.cpName} — ${lead.daysSilent} dní — ${LEAD_STATUS_LABELS[lead.status]}\n`
    }
    text += '\n'
  }

  if (unanswered.length > 0) {
    text += `═══ NEZODPOVĚZENÉ (posledních 7 dní) ═══\n`
    for (const conv of unanswered.slice(0, 10)) {
      text += `  ${conv.topic} — ${conv.cpNames.join(', ')}\n`
    }
    text += '\n'
  }

  if (events.length > 0) {
    text += `═══ KALENDÁŘ (14 dní) ═══\n`
    for (const e of events) {
      text += `  ${e.date} ${e.time} — ${e.title}${e.location ? ` (${e.location})` : ''}\n`
    }
    text += '\n'
  }

  text += `--\nMila\n`
  return text
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate and send the backfill report email.
 * Called at the end of bulk ingestion (replaces Phase 3 action proposals).
 */
export async function generateAndSendBackfillReport(
  userId: string,
  phase1: BulkIngestionPhase1Result,
  filteredSenders: FilteredSender[],
  since: Date,
  until: Date
): Promise<{ sent: boolean; error?: string }> {
  try {
    console.log(`[BackfillReport] Gathering report data for user ${userId}`)
    const data = await gatherReportData(userId, phase1, filteredSenders, since, until)

    console.log(`[BackfillReport] Generating report email`)
    const htmlContent = generateReportHtml(userId, data)
    const textContent = generateReportText(data)

    const userEmail = await getUserEmail(userId)

    await sendEmail(userId, {
      to: userEmail,
      subject: `Mila: Vaše schránka je připravena — ${data.counterparties.length} kontaktů, ${data.conversations.length} konverzací`,
      body: textContent,
      htmlBody: htmlContent,
    })

    console.log(`[BackfillReport] Report sent to ${userEmail}`)
    return { sent: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[BackfillReport] Failed to send report for user ${userId}:`, message, error)
    return { sent: false, error: message }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
