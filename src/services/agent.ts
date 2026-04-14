/**
 * Main Agent Service
 * Orchestrates the full processing pipeline
 */

import { ingestEmailsForUser, ingestOutboundEmails } from './ingestion'
import { processTimelineEntries, rebuildConversationSummary } from './threading'
import { generateActionsForConversations } from './planning'
import { ingestCalendarEvents } from './calendar-ingestion'
import { trackLeadsForUser } from './lead-tracking'
import { runReflection } from './reflection'
import { tagMessageToDeal } from './deal-tagger'
import { checkBypass } from './bypass-filter'
import { extractTemporalExpressions } from './temporal-extractor'
import { extractFactsAndBeliefs } from './fact-extractor'
import { critiqueExtraction } from './reconstruction-critic'
import { updateEntityMap } from './entity-map-updater'
import { updateBeliefLog } from './belief-log-updater'
import { updateGraph } from './graph-updater'
import { getUnassignedTimelineEntries } from '@/lib/db/timeline'
import { getConversationsForUser } from '@/lib/db/conversations'
import { getUserById, updateUserSettings, updateUserHistoryId, getUserSettings } from '@/lib/db/users'
import { getCurrentHistoryId } from '@/lib/google/gmail'
import { purgeUserAsCp } from '@/lib/db/counterparties'
import { getActiveJournalEntries, expireTemporalEntries } from '@/lib/db/journal'

import { getSupabaseAdmin } from '@/lib/supabase/client'
import type { ActionProposal, JournalEntry, UserSettings } from '@/lib/supabase/types'
import type { DealMessage, DealContext } from './fact-extractor'

export interface AgentRunResult {
  success: boolean
  emailsIngested: number
  whatsappMessagesProcessed: number
  calendarEventsSynced: number
  calendarInvitationsDetected: number
  messagesProcessed: number
  conversationsUpdated: number
  actionsGenerated: number
  followUpsGenerated: number
  coolingLeads: number
  coldLeads: number
  reflectionObservations: number
  replyDraftsGenerated: number
  actions: ActionProposal[]
  errors: string[]
  logs: string[]
}

/** Captures console.log/warn/error output during a function's execution. */
export function createLogCollector(): { logs: string[]; capture: () => () => void } {
  const logs: string[] = []
  function capture() {
    const origLog = console.log
    const origWarn = console.warn
    const origError = console.error

    const intercept = (prefix: string, orig: typeof console.log) => (...args: unknown[]) => {
      const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
      logs.push(prefix ? `${prefix} ${line}` : line)
      orig.apply(console, args)
    }

    console.log = intercept('', origLog)
    console.warn = intercept('[WARN]', origWarn)
    console.error = intercept('[ERROR]', origError)

    return () => {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
    }
  }
  return { logs, capture }
}

/**
 * Run the full agent pipeline for a user
 */
export async function runAgentForUser(userId: string): Promise<AgentRunResult> {
  const { logs, capture } = createLogCollector()
  const restore = capture()

  const result: AgentRunResult = {
    success: false,
    emailsIngested: 0,
    whatsappMessagesProcessed: 0,
    calendarEventsSynced: 0,
    calendarInvitationsDetected: 0,
    messagesProcessed: 0,
    conversationsUpdated: 0,
    actionsGenerated: 0,
    followUpsGenerated: 0,
    coolingLeads: 0,
    coldLeads: 0,
    reflectionObservations: 0,
    replyDraftsGenerated: 0,
    actions: [],
    errors: [],
    logs,
  }

  try {
    // Step 1: Verify user exists and has credentials
    console.log(`[Agent] Step 1: Verifying user credentials`)
    const user = await getUserById(userId)
    if (!user) {
      console.log(`[Agent] Step 1: FAILED — user not found`)
      result.errors.push('User not found')
      return result
    }

    if (!user.google_oauth_tokens && !user.encrypted_google_tokens) {
      console.log(`[Agent] Step 1: FAILED — no Google credentials`)
      result.errors.push('User has no Google credentials')
      return result
    }
    console.log(`[Agent] Step 1: OK — user ${user.email || userId} verified`)

    // Step 0: The user is NOT a counterparty. Purge any bad rows.
    try {
      console.log(`[Agent] Step 0: Purging user-as-counterparty rows`)
      await purgeUserAsCp(userId)
    } catch (purgeError) {
      console.error('[Agent] Step 0: Purge error:', purgeError)
      result.errors.push(`Purge: ${purgeError instanceof Error ? purgeError.message : 'Unknown error'}`)
    }

    // Step 0.5: Load journal context for this cycle
    let journalEntries: JournalEntry[] = []
    try {
      console.log(`[Agent] Step 0.5: Loading journal entries + expiring temporal`)
      journalEntries = await getActiveJournalEntries(userId, { limit: 50 })
      const expired = await expireTemporalEntries()
      console.log(`[Agent] Step 0.5: ${journalEntries.length} active entries, ${expired} temporal expired`)
    } catch (journalError) {
      console.error('[Agent] Step 0.5: Journal load error:', journalError)
      result.errors.push(`Journal: ${journalError instanceof Error ? journalError.message : 'Unknown error'}`)
    }

    // Steps 2, 2.1, 2.5 are INDEPENDENT ingestion steps — run in parallel.
    // Inbound emails, outbound emails, and calendar sync don't depend on each other.
    console.log(`[Agent] Steps 2/2.1/2.5: Ingesting emails + calendar (parallel)`)
    const parallelStart = Date.now()
    const [inboundResult, outboundResult, calendarResult] = await Promise.allSettled([
      ingestEmailsForUser(userId),
      ingestOutboundEmails(userId),
      ingestCalendarEvents(userId),
    ])
    const parallelMs = Date.now() - parallelStart

    // Collect inbound results
    if (inboundResult.status === 'fulfilled') {
      result.emailsIngested = inboundResult.value.length
      console.log(`[Agent] Step 2:   Inbound emails ingested: ${inboundResult.value.length}`)
    } else {
      console.error('[Agent] Step 2:   Inbound email ingestion FAILED:', inboundResult.reason instanceof Error ? inboundResult.reason.message : inboundResult.reason)
      result.errors.push(`Email ingestion: ${inboundResult.reason instanceof Error ? inboundResult.reason.message : 'Unknown error'}`)
    }

    // Collect outbound results
    if (outboundResult.status === 'fulfilled') {
      result.emailsIngested += outboundResult.value
      console.log(`[Agent] Step 2.1: Outbound emails ingested: ${outboundResult.value}`)
    } else {
      console.error('[Agent] Step 2.1: Outbound email ingestion FAILED:', outboundResult.reason instanceof Error ? outboundResult.reason.message : outboundResult.reason)
      result.errors.push(`Outbound ingestion: ${outboundResult.reason instanceof Error ? outboundResult.reason.message : 'Unknown error'}`)
    }

    // Collect calendar results
    if (calendarResult.status === 'fulfilled') {
      result.calendarEventsSynced = calendarResult.value.eventsSynced
      result.calendarInvitationsDetected = calendarResult.value.invitationsDetected
      result.actionsGenerated += calendarResult.value.actionsCreated
      console.log(`[Agent] Step 2.5: Calendar synced: ${calendarResult.value.eventsSynced} events, ${calendarResult.value.invitationsDetected} invitations`)
      if (calendarResult.value.errors.length > 0) {
        result.errors.push(...calendarResult.value.errors)
      }
    } else {
      console.error('[Agent] Step 2.5: Calendar ingestion FAILED:', calendarResult.reason instanceof Error ? calendarResult.reason.message : calendarResult.reason)
      result.errors.push(`Calendar ingestion: ${calendarResult.reason instanceof Error ? calendarResult.reason.message : 'Unknown error'}`)
    }
    console.log(`[Agent] Steps 2/2.1/2.5 completed in ${(parallelMs / 1000).toFixed(1)}s`)

    // Save Gmail historyId for dispatcher's incremental check.
    // Done after ingestion so the dispatcher knows where we left off.
    try {
      const historyId = await getCurrentHistoryId(userId)
      if (historyId) {
        await updateUserHistoryId(userId, historyId)
      }
    } catch (historyErr) {
      // Non-fatal — dispatcher will treat missing historyId as "has changes"
      console.error('[Agent] Failed to save Gmail historyId:', historyErr instanceof Error ? historyErr.message : historyErr)
    }

    // Step 3: Get all unprocessed messages (including newly ingested + WhatsApp)
    // Steps 3-5 depend on each other but are isolated from steps 2/2.5/6
    try {
      console.log(`[Agent] Step 3: Loading unassigned timeline entries`)
      const unassignedEntries = await getUnassignedTimelineEntries(userId)
      result.messagesProcessed = unassignedEntries.length
      result.whatsappMessagesProcessed = unassignedEntries.filter(
        e => e.event_type === 'whatsapp'
      ).length
      console.log(`[Agent] Step 3: Found ${unassignedEntries.length} unassigned (${result.whatsappMessagesProcessed} WhatsApp)`)

      // Step 4: Process messages into conversations
      if (unassignedEntries.length > 0) {
        console.log(`[Agent] Step 4: Threading messages into conversations`)
        const conversations = await processTimelineEntries(unassignedEntries)
        result.conversationsUpdated = conversations.size
        console.log(`[Agent] Step 4: Threaded into ${conversations.size} conversations`)

        // Step 4.5: Rebuild summaries for ALL updated conversations before planning.
        // Threading only rebuilds after 5 new messages — but planning needs fresh
        // summaries even after 1 new message. Force rebuild here.
        console.log(`[Agent] Step 4.5: Rebuilding summaries for ${conversations.size} conversations`)
        for (const conv of conversations.values()) {
          try {
            await rebuildConversationSummary(conv)
          } catch (err) {
            console.error(`[Agent] Step 4.5: Summary rebuild failed for ${conv.id}:`, err)
          }
        }

        // Step 4b: Deal pipeline — tag entries to deals + run world model updates
        // Dual-write: old path (conversations/enriched_text) continues above.
        // New path writes deal_id + entity_map + belief_log + deal_graph alongside it.
        try {
          const userSettings: UserSettings | null = await getUserSettings(userId)
          if (userSettings) {
            await Promise.allSettled(
              unassignedEntries.map(async (entry) => {
                try {
                  // 1. Bypass filter — flag genuine same-day emergencies
                  if (entry.content?.trim()) {
                    const bypass = await checkBypass(entry.content, entry.event_type, userSettings)
                    if (bypass.isEmergency) {
                      const supabase = getSupabaseAdmin()
                      await supabase
                        .from('deal_timeline')
                        .update({ is_emergency: true })
                        .eq('id', entry.id)
                      console.log(`[Agent] Step 4b: EMERGENCY entry ${entry.id} — ${bypass.reason}`)
                    }
                  }

                  // 2. Tag to deal (skip if already tagged by ingestion)
                  const dealId = entry.deal_id ?? (await tagMessageToDeal(entry, userId)).id

                  if (!entry.content?.trim()) return

                  // 3. Temporal extraction
                  const temporalResult = await extractTemporalExpressions(
                    entry.content,
                    new Date(entry.occurred_at),
                    userSettings
                  )

                  // 4. Fact & belief extraction (single-message batch)
                  const dealMessage: DealMessage = {
                    id: entry.id,
                    direction: entry.direction as DealMessage['direction'],
                    content: entry.content,
                    occurred_at: entry.occurred_at,
                    channel: entry.event_type as DealMessage['channel'],
                  }
                  const dealContext: DealContext = {
                    deal_id: dealId,
                    deal_title: entry.content.slice(0, 80),
                    deal_type: 'other',
                  }
                  const extraction = await extractFactsAndBeliefs(
                    [dealMessage], temporalResult, dealContext, userSettings
                  )

                  // 5. Reconstruction critic (fail-open — gaps logged for future use)
                  const critique = await critiqueExtraction([entry.content], extraction)
                  if (!critique.is_complete && critique.gaps.length > 0) {
                    console.log(`[Agent] Step 4b: Extraction gaps for entry ${entry.id}: ${critique.gaps.join('; ')}`)
                  }

                  // 6. World model updates (entity map + belief log + dependency graph)
                  await Promise.allSettled([
                    updateEntityMap(userId, dealId, extraction.hard_facts),
                    updateBeliefLog(userId, dealId, extraction.soft_observations, userSettings.ai_language),
                    updateGraph(userId, dealId, extraction.hard_facts),
                  ])
                } catch (entryErr) {
                  console.warn(`[Agent] Step 4b: Pipeline failed for entry ${entry.id}:`, entryErr)
                }
              })
            )
          }
        } catch (step4bErr) {
          // Non-fatal — old pipeline unaffected
          console.error('[Agent] Step 4b: Deal pipeline error:', step4bErr)
        }

        // Step 5: Generate action proposals for updated conversations
        const conversationIds = Array.from(conversations.keys())

        // Also pick up conversations flagged via backfill report "Přidat do Mila"
        const flagged = await getConversationsForUser(userId, { state: 'needs_proposals' })
        for (const fc of flagged) {
          if (!conversationIds.includes(fc.id)) conversationIds.push(fc.id)
        }

        console.log(`[Agent] Step 5: Generating action proposals for ${conversationIds.length} conversations (${flagged.length} from backfill)`)
        const actions = await generateActionsForConversations(conversationIds)
        result.actionsGenerated += actions.length
        result.actions = actions
        console.log(`[Agent] Step 5: Generated ${actions.length} actions`)

        // Clear the flag on processed conversations
        if (flagged.length > 0) {
          const supabase = getSupabaseAdmin()
          await supabase
            .from('conversation_threads')
            .update({ state: null })
            .in('id', flagged.map(f => f.id))
        }
      } else {
        // No unprocessed messages, but still check for backfill-flagged conversations
        const flagged = await getConversationsForUser(userId, { state: 'needs_proposals' })
        if (flagged.length > 0) {
          console.log(`[Agent] Step 5: Processing ${flagged.length} backfill-flagged conversations`)
          const actions = await generateActionsForConversations(flagged.map(f => f.id))
          result.actionsGenerated += actions.length
          result.actions = actions
          console.log(`[Agent] Step 5: Generated ${actions.length} actions from backfill`)

          const supabase = getSupabaseAdmin()
          await supabase
            .from('conversation_threads')
            .update({ state: null })
            .in('id', flagged.map(f => f.id))
        } else {
          console.log(`[Agent] Steps 4-5: Skipped — no unassigned timeline entries`)
        }
      }
    } catch (processingError) {
      console.error('[Agent] Steps 3-5 FAILED:', processingError instanceof Error ? processingError.message : processingError)
      result.errors.push(`Processing: ${processingError instanceof Error ? processingError.message : 'Unknown error'}`)
    }

    // Step 6: Lead tracking — detect cooling/cold leads, create follow-up actions
    try {
      console.log(`[Agent] Step 6: Tracking leads`)
      const leadResult = await trackLeadsForUser(userId)
      result.followUpsGenerated = leadResult.followUpsCreated
      result.coolingLeads = leadResult.coolingLeads
      result.coldLeads = leadResult.coldLeads
      result.actionsGenerated += leadResult.followUpsCreated
      console.log(`[Agent] Step 6: ${leadResult.coolingLeads} cooling, ${leadResult.coldLeads} cold, ${leadResult.followUpsCreated} follow-ups created`)
      if (leadResult.errors.length > 0) {
        result.errors.push(...leadResult.errors)
      }
    } catch (leadError) {
      console.error('[Agent] Step 6 FAILED:', leadError instanceof Error ? leadError.message : leadError)
      result.errors.push(`Lead tracking: ${leadError instanceof Error ? leadError.message : 'Unknown error'}`)
    }

    // Step 7: Reflection — observe patterns, write to journal
    try {
      console.log(`[Agent] Step 7: Running reflection`)
      const reflectionResult = await runReflection(userId)
      result.reflectionObservations = reflectionResult.observationsWritten
      await updateUserSettings(userId, { last_reflection_at: new Date().toISOString() })
      console.log(`[Agent] Step 7: Reflection complete — ${reflectionResult.observationsWritten} observations`)
    } catch (err) {
      console.error(`[Agent] Step 7: Reflection failed —`, err)
      result.errors.push(`Reflection: ${err instanceof Error ? err.message : 'Unknown error'}`)
      // Non-fatal: don't fail the pipeline
    }

    result.success = true
  } catch (error) {
    console.error('[Agent] Error:', error)
    result.errors.push(error instanceof Error ? error.message : 'Unknown error')
  } finally {
    restore()
  }

  return result
}

// runAgentForAllUsers removed — replaced by /api/agent/dispatch endpoint
// which uses Gmail history.list to check for new mail and fans out via QStash.

// ─── Flow A export (Chunk 9b) ─────────────────────────────────────────────────
//
// Flow A = ingestion + world model updates only.
// No planning, no lead tracking, no reflection.
// Called by /api/planner/run (Flow B) after ingestion to ensure fresh data.
// Also called directly by dispatcher for 24/7 ingestion (Chunk 10 cutover).

export interface FlowAResult {
  success: boolean
  emailsIngested: number
  messagesProcessed: number
  errors: string[]
}

export async function runFlowA(userId: string): Promise<FlowAResult> {
  const result: FlowAResult = {
    success: false,
    emailsIngested: 0,
    messagesProcessed: 0,
    errors: [],
  }

  try {
    // Step 1: Verify user exists and has credentials
    const user = await getUserById(userId)
    if (!user) {
      result.errors.push('User not found')
      return result
    }
    if (!user.google_oauth_tokens && !user.encrypted_google_tokens) {
      result.errors.push('User has no Google credentials')
      return result
    }

    // Step 0: Purge user-as-counterparty rows
    try {
      await purgeUserAsCp(userId)
    } catch (err) {
      result.errors.push(`Purge: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }

    // Step 0.5: Expire temporal journal entries
    try {
      await expireTemporalEntries()
    } catch (err) {
      result.errors.push(`Journal expire: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }

    // Steps 2/2.1/2.5: Ingest emails + calendar in parallel
    const [inboundResult, outboundResult] = await Promise.allSettled([
      ingestEmailsForUser(userId),
      ingestOutboundEmails(userId),
      ingestCalendarEvents(userId),
    ])

    if (inboundResult.status === 'fulfilled') {
      result.emailsIngested += inboundResult.value.length
    } else {
      result.errors.push(`Email ingestion: ${inboundResult.reason instanceof Error ? inboundResult.reason.message : 'Unknown error'}`)
    }
    if (outboundResult.status === 'fulfilled') {
      result.emailsIngested += outboundResult.value
    } else {
      result.errors.push(`Outbound ingestion: ${outboundResult.reason instanceof Error ? outboundResult.reason.message : 'Unknown error'}`)
    }

    // Save Gmail historyId
    try {
      const historyId = await getCurrentHistoryId(userId)
      if (historyId) await updateUserHistoryId(userId, historyId)
    } catch { /* non-fatal */ }

    // Step 3: Get unassigned timeline entries
    const unassignedEntries = await getUnassignedTimelineEntries(userId)
    result.messagesProcessed = unassignedEntries.length

    if (unassignedEntries.length > 0) {
      // Step 4: Thread into conversations (legacy path — kept for backward compat)
      try {
        const conversations = await processTimelineEntries(unassignedEntries)
        for (const conv of conversations.values()) {
          try {
            await rebuildConversationSummary(conv)
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        result.errors.push(`Threading: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }

      // Step 4b: New deal pipeline (world model updates)
      try {
        const userSettings: UserSettings | null = await getUserSettings(userId)
        if (userSettings) {
          await Promise.allSettled(
            unassignedEntries.map(async (entry) => {
              try {
                if (entry.content?.trim()) {
                  const bypass = await checkBypass(entry.content, entry.event_type, userSettings)
                  if (bypass.isEmergency) {
                    const supabase = getSupabaseAdmin()
                    await supabase.from('deal_timeline').update({ is_emergency: true }).eq('id', entry.id)
                  }
                }

                const dealId = entry.deal_id ?? (await tagMessageToDeal(entry, userId)).id
                if (!entry.content?.trim()) return

                const temporalResult = await extractTemporalExpressions(
                  entry.content, new Date(entry.occurred_at), userSettings
                )

                const dealMessage: DealMessage = {
                  id: entry.id,
                  direction: entry.direction as DealMessage['direction'],
                  content: entry.content,
                  occurred_at: entry.occurred_at,
                  channel: entry.event_type as DealMessage['channel'],
                }
                const dealContext: DealContext = {
                  deal_id: dealId,
                  deal_title: entry.content.slice(0, 80),
                  deal_type: 'other',
                }
                const extraction = await extractFactsAndBeliefs([dealMessage], temporalResult, dealContext, userSettings)

                const critique = await critiqueExtraction([entry.content], extraction)
                if (!critique.is_complete && critique.gaps.length > 0) {
                  console.log(`[FlowA] Extraction gaps for entry ${entry.id}: ${critique.gaps.join('; ')}`)
                }

                await Promise.allSettled([
                  updateEntityMap(userId, dealId, extraction.hard_facts),
                  updateBeliefLog(userId, dealId, extraction.soft_observations, userSettings.ai_language),
                  updateGraph(userId, dealId, extraction.hard_facts),
                ])
              } catch (entryErr) {
                console.warn(`[FlowA] Pipeline failed for entry ${entry.id}:`, entryErr)
              }
            })
          )
        }
      } catch (err) {
        result.errors.push(`World model: ${err instanceof Error ? err.message : 'Unknown error'}`)
      }
    }

    result.success = true
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : 'Unknown error')
  }

  return result
}
