/**
 * Mila Context Builder — assembles what Mila knows for each AI decision.
 *
 * Three depth levels:
 *   - light:  last 3 timeline + top 5 journal beliefs (brief headlines, intros)
 *   - medium: last 5 timeline + scoped journal (planning triage, lead follow-up)
 *   - full:   last 10 timeline + all scoped journal + enriched fields (detail fills, drafts)
 *
 * This replaces the pattern where each AI function independently assembles thin context.
 * Timeline is the source of truth. Journal is Mila's accumulated knowledge.
 * Conversation summary is a cached orientation, not the primary context.
 */

import type { ConversationSummary, DealTimelineEntry, JournalEntry } from '@/lib/supabase/types'
import { getTimelineForConversation } from '@/lib/db/timeline'
import { getJournalEntriesForContext } from '@/lib/db/journal'
import { getRecentMessages } from '@/lib/db/conversations'
import { parseEnrichedText, type EnrichedMessageData } from './gemini'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ContextDepth = 'light' | 'medium' | 'full'

export interface MilaContext {
  /** Recent timeline entries — chronological, most recent last */
  timeline: DealTimelineEntry[]
  /** Journal beliefs/observations scoped to this CP, conversation, + global */
  journal: JournalEntry[]
  /** Structured enriched fields from the latest inbound message (if available) */
  enriched: EnrichedMessageData | null
  /** Conversation summary — cached orientation */
  summary: ConversationSummary | null
}

const TIMELINE_LIMITS: Record<ContextDepth, number> = {
  light: 3,
  medium: 5,
  full: 10,
}

const JOURNAL_LIMITS: Record<ContextDepth, number> = {
  light: 5,
  medium: 15,
  full: 30,
}

// ─── Builder ────────────────────────────────────────────────────────────────

export async function buildMilaContext(
  conversationId: string,
  userId: string,
  cpId: string | null,
  summary: ConversationSummary | null,
  depth: ContextDepth = 'medium'
): Promise<MilaContext> {
  const timelineLimit = TIMELINE_LIMITS[depth]
  const journalLimit = JOURNAL_LIMITS[depth]

  // Fetch timeline + journal in parallel
  const [timeline, journal] = await Promise.all([
    getTimelineForConversation(conversationId, timelineLimit),
    getJournalEntriesForContext(
      userId,
      [conversationId],
      cpId ? [cpId] : []
    ).then(entries => entries.slice(0, journalLimit)),
  ])

  // For 'full' depth, extract enriched structured data from latest inbound message
  let enriched: EnrichedMessageData | null = null
  if (depth === 'full') {
    // Find latest inbound message with enriched_text
    const recentMessages = await getRecentMessages(conversationId, 5)
    const latestInbound = [...recentMessages]
      .reverse()
      .find(m => m.direction === 'inbound' && m.enriched_text)
    if (latestInbound?.enriched_text) {
      enriched = parseEnrichedText(latestInbound.enriched_text)
    }
  }

  return { timeline, journal, enriched, summary }
}

// ─── Formatters (for prompt injection) ──────────────────────────────────────

/**
 * Format timeline entries for prompt injection.
 * Compact: "[in/email 2d ago] content preview..."
 */
export function formatTimelineForPrompt(entries: DealTimelineEntry[]): string {
  if (entries.length === 0) return '(no recent activity)'

  const now = Date.now()
  return entries.map(e => {
    const daysAgo = Math.max(0, Math.round((now - new Date(e.occurred_at).getTime()) / 86_400_000))
    const ago = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`
    const dir = e.direction === 'in' ? 'inbound' : e.direction === 'out' ? 'outbound' : e.direction
    const content = (e.content || '').slice(0, 200)
    return `[${dir}/${e.event_type} ${ago}] ${content}`
  }).join('\n')
}

/**
 * Format journal entries for prompt injection.
 * Groups by scope for readability. Highlights confirmed beliefs.
 */
export function formatJournalForPrompt(entries: JournalEntry[]): string {
  if (entries.length === 0) return ''

  const beliefs = entries.filter(e => e.type === 'belief')
  const observations = entries.filter(e => e.type === 'observation')
  const volatile = entries.filter(e => e.type === 'volatile')

  const lines: string[] = []

  if (beliefs.length > 0) {
    lines.push('CONFIRMED BELIEFS (high confidence):')
    for (const b of beliefs) {
      const scope = b.scope === 'global' ? '' : ` [${b.scope}: ${b.scope_ref || ''}]`
      lines.push(`- ${b.topic}: ${b.content}${scope}`)
    }
  }

  if (observations.length > 0) {
    lines.push(beliefs.length > 0 ? '\nOBSERVATIONS:' : 'OBSERVATIONS:')
    for (const o of observations) {
      const scope = o.scope === 'global' ? '' : ` [${o.scope}: ${o.scope_ref || ''}]`
      lines.push(`- ${o.topic}: ${o.content}${scope}`)
    }
  }

  if (volatile.length > 0) {
    lines.push('\nUNCERTAIN (conflicting signals):')
    for (const v of volatile) {
      lines.push(`- ${v.topic}: ${v.content}`)
    }
  }

  return lines.join('\n')
}

/**
 * Format enriched fields for prompt injection.
 * Only includes non-null fields.
 */
export function formatEnrichedForPrompt(data: EnrichedMessageData | null): string {
  if (!data) return ''

  const lines: string[] = []
  if (data.addresses?.length) lines.push(`Addresses mentioned: ${data.addresses.join(', ')}`)
  if (data.proposedTimes?.length) {
    lines.push(`Proposed times: ${data.proposedTimes.map(t => `"${t.original}" → ${t.interpreted}`).join('; ')}`)
  }
  if (data.meetingType) lines.push(`Meeting type: ${data.meetingType}`)
  if (data.urgency) lines.push(`Urgency signal: "${data.urgency.quote}" (${data.urgency.classification})`)
  if (data.dealStage) lines.push(`Deal stage: ${data.dealStage}`)
  if (data.keyNumbers) {
    const nums: string[] = []
    if (data.keyNumbers.price) nums.push(`price: ${data.keyNumbers.price}`)
    if (data.keyNumbers.area) nums.push(`area: ${data.keyNumbers.area}`)
    if (data.keyNumbers.dates?.length) nums.push(`dates: ${data.keyNumbers.dates.join(', ')}`)
    if (nums.length) lines.push(`Key numbers: ${nums.join(', ')}`)
  }

  return lines.length > 0 ? 'EXTRACTED FROM LATEST INBOUND:\n' + lines.join('\n') : ''
}

/**
 * Build a complete context block for prompt injection.
 * Combines all MilaContext data into a single string.
 */
export function formatMilaContextForPrompt(ctx: MilaContext): string {
  const sections: string[] = []

  // Timeline is always included
  sections.push(`RECENT TIMELINE:\n${formatTimelineForPrompt(ctx.timeline)}`)

  // Journal — Mila's accumulated knowledge
  const journalText = formatJournalForPrompt(ctx.journal)
  if (journalText) {
    sections.push(`MILA'S NOTES:\n${journalText}`)
  }

  // Enriched fields — structured extraction from latest message
  const enrichedText = formatEnrichedForPrompt(ctx.enriched)
  if (enrichedText) {
    sections.push(enrichedText)
  }

  return sections.join('\n\n')
}
