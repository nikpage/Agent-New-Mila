/**
 * Main Agent Service
 * Orchestrates the full processing pipeline
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'

import { ingestEmailsForUser, ingestOutboundEmails } from './ingestion'
import { processTimelineEntries, rebuildConversationSummary } from './threading'
import { ingestCalendarEvents } from './calendar-ingestion'
import { runReflection } from './reflection'
import { walkAllDeals } from './graph-walker'
import type { WalkerTask } from './graph-walker'
import { scoreWalkerOutput } from './scoring-engine'
import { generateCards, insertCardsAsActions } from './card-generator'
import { tagMessageToDeal } from './deal-tagger'
import { checkBypass } from './bypass-filter'
import { extractTemporalExpressions } from './temporal-extractor'
import { extractFactsAndBeliefs } from './fact-extractor'
import { critiqueExtraction } from './reconstruction-critic'
import { updateEntityMap } from './entity-map-updater'
import { updateBeliefLog } from './belief-log-updater'
import { updateGraph } from './graph-updater'
import { getUnassignedTimelineEntries, getTimelineContextForConversations } from '@/lib/db/timeline'
import { getConversationsForUser, updateConversation } from '@/lib/db/conversations'
import { getUserById, updateUserSettings, updateUserHistoryId, getUserSettings } from '@/lib/db/users'
import { getCurrentHistoryId } from '@/lib/google/gmail'
import { purgeUserAsCp, getCPById } from '@/lib/db/counterparties'
import { getActiveJournalEntries, expireTemporalEntries, getJournalEntriesForContext } from '@/lib/db/journal'
import { getPendingActionsByType } from '@/lib/db/actions'
import { getEntitiesForDeal } from '@/lib/db/entity-map'
import { triageConversation, verifyTriage, parseEnrichedText, extractMessageFacts } from '@/lib/ai/tasks'
import type { ExtractionResult } from '@/lib/ai/tasks'

import { getSupabaseAdmin } from '@/lib/supabase/client'
import type { ActionProposal, JournalEntry, UserSettings, ConversationThread, ConversationSummary } from '@/lib/supabase/types'
import type { DealMessage, DealContext } from './fact-extractor'
import { resetAIUsage, getAIUsageSummary, formatAIUsageTable, type AIStageUsage } from '@/lib/ai/runner'
import { insertAIUsage, type AIUsageRow } from '@/lib/db/ai-usage'

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
  aiUsage?: {
    stages: AIStageUsage[]
    totalInputTokens: number
    totalOutputTokens: number
    totalCalls: number
    totalCostUSD: number
  }
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

  resetAIUsage()

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

    // Conversations that received new inbound messages this run — used by Step 5 triage.
    let newInboundConversations: Map<string, ConversationThread> | undefined
    // Maps conversationId → dealId from step 4b — used by step 5 entity map lookup.
    const convDealMap = new Map<string, string>()

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
        newInboundConversations = conversations
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
                  // Record conv → deal mapping so step 5 can look up entities correctly.
                  if (entry.conversation_id) convDealMap.set(entry.conversation_id, dealId)
                  // Persist to DB for future runs (conversation_threads.deal_id).
                  if (entry.conversation_id && !entry.deal_id) {
                    updateConversation(entry.conversation_id, { deal_id: dealId }).catch(() => {
                      // Non-fatal — convDealMap already covers this run
                    })
                  }

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
                    messageId: entry.message_id,
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
                  if (extraction.scratchpad) {
                    console.log(`[Agent] Step 4b: Scratchpad for entry ${entry.id}:\n${extraction.scratchpad}`)
                  }
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

      } else {
        console.log(`[Agent] Steps 4-4b: Skipped — no unassigned timeline entries`)
      }
    } catch (processingError) {
      console.error('[Agent] Steps 3-4b FAILED:', processingError instanceof Error ? processingError.message : processingError)
      result.errors.push(`Processing: ${processingError instanceof Error ? processingError.message : 'Unknown error'}`)
    }

    // Step 5: Batch planner — graph walker → scoring engine → card generator → action_proposals
    // Replaces: planning.ts (per-conversation AI triage) + lead-tracking.ts (separate lead scan)
    // Lead detection is now part of the graph walker (lead_cooling / lead_cold / lead_dead tasks).
    try {
      console.log(`[Agent] Step 5: Running batch planner (graph walker → scoring → cards)`)
      const plannerSettings = await getUserSettings(userId)
      if (plannerSettings) {
        const walkerOutputs = await walkAllDeals(userId, plannerSettings)

        // Triage conversations that received new inbound messages this run.
        // Produces message-level WalkerTasks ranked alongside graph-level walker tasks.
        const triageTasks: WalkerTask[] = []
        const triageEntries: Array<{ task: WalkerTask; actionType: string }> = []

        if (newInboundConversations && newInboundConversations.size > 0) {
          const convIds = [...newInboundConversations.keys()]

          // Fetch timeline context first, then journal with actual cpIds
          const timelineContext = await getTimelineContextForConversations(convIds, 15)

          const cpIds = new Set<string>()
          for (const entries of timelineContext.values()) {
            for (const e of entries) { if (e.cp_id) cpIds.add(e.cp_id) }
          }

          const journalWithCps = await getJournalEntriesForContext(userId, convIds, [...cpIds])

          // Pre-fetch enriched_text from messages for the latest inbound per conversation.
          // deal_timeline.content is plain cleaned text — enrichment JSON lives in messages.enriched_text.
          // Without this, parseEnrichedText always returns null and venue/time resolution never works.
          const enrichedTextByConv = new Map<string, string>()
          {
            const messageIdToConv = new Map<string, string>()
            for (const [convId, entries] of timelineContext) {
              const latestIn = [...entries]
                .filter(e => e.direction === 'in' && e.message_id)
                .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())[0]
              if (latestIn?.message_id) messageIdToConv.set(latestIn.message_id, convId)
            }
            if (messageIdToConv.size > 0) {
              const { data: msgRows } = await getSupabaseAdmin()
                .from('messages')
                .select('id, enriched_text')
                .in('id', [...messageIdToConv.keys()])
              for (const row of msgRows ?? []) {
                const convId = messageIdToConv.get(row.id)
                if (convId && row.enriched_text) enrichedTextByConv.set(convId, row.enriched_text)
              }
            }
          }

          const convArray = [...newInboundConversations.entries()]
          for (let i = 0; i < convArray.length; i += 5) {
            const batch = convArray.slice(i, i + 5)
            await Promise.allSettled(batch.map(async ([convId, conv]) => {
              try {
                const convEntries = timelineContext.get(convId) ?? []
                const latestInbound = [...convEntries]
                  .filter(e => e.direction === 'in')
                  .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())[0]

                if (!latestInbound?.content) return

                const now = Date.now()
                const recentMessages = convEntries.map(e => {
                  const diffH = Math.floor((now - new Date(e.occurred_at).getTime()) / 3_600_000)
                  const age = diffH < 24 ? `${diffH}h ago` : `${Math.floor(diffH / 24)}d ago`
                  return { direction: e.direction ?? 'in', text: e.content ?? '', age }
                })

                const summary = conv.summary_json as ConversationSummary | null

                const pendingByType = await getPendingActionsByType(convId)
                const pendingActions = [...pendingByType.entries()].map(([type, a]) => ({
                  type, intent: a.intent_cs ?? '', urgency: a.urgency,
                }))

                const cpId = latestInbound.cp_id
                let cpName = 'Unknown'
                if (cpId) {
                  const cp = await getCPById(cpId)
                  cpName = cp?.name ?? 'Unknown'
                }

                const channel: 'email' | 'whatsapp' =
                  latestInbound.event_type === 'whatsapp' ? 'whatsapp' : 'email'

                const convJournalText = journalWithCps
                  .filter(j =>
                    j.scope === 'global' ||
                    j.scope_ref === convId ||
                    (cpId != null && j.scope_ref === cpId)
                  )
                  .map(j => j.content)
                  .join('\n')

                // Enrichment: use messages.enriched_text (JSON), not timeline content (plain text).
                const enrichedText = enrichedTextByConv.get(convId) ?? null
                const enrichment = enrichedText ? parseEnrichedText(enrichedText) : null

                const triageResult = await triageConversation(
                  latestInbound.content,
                  recentMessages,
                  summary,
                  pendingActions,
                  cpName,
                  channel,
                  plannerSettings,
                  convJournalText,
                  enrichment,
                )

                // Snooze: triage says come back later — update conversation and skip action creation
                if (!triageResult.needs_action && triageResult.revisit_at) {
                  await updateConversation(convId, { snooze_until: triageResult.revisit_at })
                  console.log(`[Agent] Step 5: Snoozed conv ${convId} until ${triageResult.revisit_at}: ${triageResult.revisit_reason ?? ''}`)
                  return
                }

                if (!triageResult.needs_action || !triageResult.action) return

                const verify = await verifyTriage(latestInbound.content, triageResult, plannerSettings)
                if (!verify.action_justified) {
                  if (triageResult.action.urgency_category === 'CRITICAL') {
                    // CRITICAL urgency: trust triage, don't let verify kill it
                    console.log(`[Agent] Step 5: verifyTriage veto overridden for CRITICAL — conv ${convId}`)
                  } else {
                    console.log(`[Agent] Step 5: verifyTriage VETO — conv ${convId} (${triageResult.action.urgency_category}) action dropped`)
                    return
                  }
                }

                const urgencyMap: Record<string, number> = {
                  CRITICAL: 9, TODAY: 8, THIS_WEEK: 6, SOON: 4, NONE: 1,
                }

                // Load entity map from DB for this deal.
                // convDealMap takes priority — it carries the deal ID written in step 4b
                // for this run. conv.deal_id may be null for conversations created this run.
                const dealIdForTask = convDealMap.get(convId) ?? conv.deal_id ?? convId
                let entityMapSnapshot: Record<string, string> = {}
                try {
                  const entities = await getEntitiesForDeal(dealIdForTask)
                  entityMapSnapshot = entities.reduce((acc, e) => ({
                    ...acc,
                    [`${e.entity_type}.${e.entity_key}`]: e.entity_value,
                  }), {} as Record<string, string>)
                  // Fallback: if entity map has no price but enrichment does, inject it.
                  // Covers first-run cases where entity_map hasn't been written yet.
                  if (!entityMapSnapshot['price.asking_price'] && !entityMapSnapshot['price.sale_price']
                      && enrichment?.keyNumbers?.price) {
                    entityMapSnapshot['price.asking_price'] = enrichment.keyNumbers.price
                  }
                } catch {
                  // fail open — empty snapshot is fine
                }

                // extractMessageFacts: dedicated venue/time extraction stage (triage_extract).
                // Always runs — triage is unreliable for physical venue (picks property address
                // instead of meeting venue). Extraction uses the message text directly and
                // resolves "tomorrow at 9" to ISO datetime. Used as primary source below.
                let extraction: ExtractionResult | null = null
                try {
                  extraction = await extractMessageFacts(
                    latestInbound.content,
                    enrichment,
                    summary,
                    cpName,
                    plannerSettings,
                  )
                } catch (err) {
                  console.warn(`[Agent] Step 5: extractMessageFacts failed for conv ${convId}:`, err)
                }

                // Helper: resolve a proposedTime index to ISO string.
                // Handles both explicit dates (specificDate) and relative references
                // (relativeRef: "tomorrow", "today") — the latter is common for urgent meetings.
                const tz = plannerSettings?.timezone || 'Europe/Prague'
                const nowForDates = new Date()
                const todayIso = nowForDates.toLocaleDateString('sv-SE', { timeZone: tz })
                const tomorrowIso = new Date(nowForDates.getTime() + 86400000).toLocaleDateString('sv-SE', { timeZone: tz })
                const resolveTimeIndex = (index: number | null | undefined): string | null => {
                  if (index == null) return null
                  const pt = enrichment?.proposedTimes?.[index]
                  if (!pt) return null
                  if (pt.specificDate && pt.timeOfDay) return `${pt.specificDate}T${pt.timeOfDay}:00`
                  if (pt.specificDate) return `${pt.specificDate}T09:00:00`
                  if (pt.relativeRef === 'tomorrow' && pt.timeOfDay) return `${tomorrowIso}T${pt.timeOfDay}:00`
                  if (pt.relativeRef === 'tomorrow') return `${tomorrowIso}T09:00:00`
                  if (pt.relativeRef === 'today' && pt.timeOfDay) return `${todayIso}T${pt.timeOfDay}:00`
                  if (pt.relativeRef === 'today') return `${todayIso}T09:00:00`
                  return null
                }

                // Resolve venue and time from triage result for ALL action types.
                // Venue resolution must happen before the primary task is built so SCHEDULE
                // tasks (primary or auto) carry the correct location into the payload,
                // enabling travel buffer creation in the optimizer.
                // Priority: extraction index → extraction freetext → triage index → triage freetext
                // Index-first because freetext from extraction can be a description ("u notáře") not an address.
                const ta = triageResult.action
                const resolvedVenue =
                  (extraction?.confirmed_venue_index != null ? enrichment?.addresses?.[extraction.confirmed_venue_index] ?? null : null)
                  ?? extraction?.confirmed_venue_freetext
                  ?? (ta.venue_index != null ? enrichment?.addresses?.[ta.venue_index] ?? null : null)
                  ?? ta.meeting_venue
                  ?? null
                const resolvedTime =
                  extraction?.confirmed_time_freetext
                  ?? resolveTimeIndex(extraction?.confirmed_time_index)
                  ?? resolveTimeIndex(ta.time_index)
                  ?? ta.proposed_time
                  ?? null

                const task: WalkerTask = {
                  nodeId: `triage:${convId}`,
                  dealId: dealIdForTask,
                  taskType: 'triage_action',
                  deadline: null,
                  hoursUntilDue: null,
                  slack: null,
                  cpId: cpId ?? null,
                  entityMapSnapshot,
                  beliefSnapshot: [],
                  triageUrgency: urgencyMap[triageResult.action.urgency_category] ?? 5,
                  triageActionType: triageResult.action.type as 'REPLY' | 'SCHEDULE' | 'TODO',
                  triageIntentCs: triageResult.action.intent_cs,
                  triageRationaleCs: triageResult.action.rationale_cs,
                  triageWhatCpWants: triageResult.action.what_cp_wants,
                  triageMissingInfo: triageResult.action.missing_info ?? [],
                  triageCpName: cpName,
                  triageWeight: triageResult.action.immovable ? 100 : triageResult.action.weight,
                  triageImmovable: triageResult.action.immovable,
                  // Set venue/time on primary task when it IS the SCHEDULE action
                  ...(triageResult.action.type === 'SCHEDULE' ? {
                    triageMeetingVenue: resolvedVenue,
                    triageProposedTime: resolvedTime,
                  } : {}),
                }

                triageEntries.push({ task, actionType: triageResult.action.type })
                triageTasks.push(task)
                console.log(`[Agent] Step 5: Triage → ${triageResult.action.type} (${triageResult.action.urgency_category}) for conv ${convId}`)

                // Auto-SCHEDULE: if primary action is REPLY/TODO and triage detected venue/time,
                // create a secondary SCHEDULE task (same logic as old planning.ts code gate)
                if (ta.type !== 'SCHEDULE') {
                  if (resolvedVenue || resolvedTime) {
                    const scheduleTask: WalkerTask = {
                      nodeId: `triage:schedule:${convId}`,
                      dealId: dealIdForTask,
                      taskType: 'triage_action',
                      deadline: resolvedTime,
                      hoursUntilDue: null,
                      slack: null,
                      cpId: cpId ?? null,
                      entityMapSnapshot,
                      beliefSnapshot: [],
                      triageUrgency: urgencyMap[ta.urgency_category] ?? 5,
                      triageActionType: 'SCHEDULE',
                      triageMeetingVenue: resolvedVenue,
                      triageProposedTime: resolvedTime,
                      // Use CP's stated request as intent base — better context for generateSchedulingIntent().
                      // Falls back to generic only if what_cp_wants is empty.
                      triageIntentCs: ta.what_cp_wants
                        ? `Naplánovat: ${ta.what_cp_wants.slice(0, 80)}.`
                        : 'Naplánovat schůzku dle požadavku.',
                      triageRationaleCs: ta.rationale_cs || 'Protistrana navrhla čas nebo místo.',
                    }
                    triageEntries.push({ task: scheduleTask, actionType: 'SCHEDULE' })
                    triageTasks.push(scheduleTask)
                    console.log(`[Agent] Step 5: Auto-SCHEDULE for conv ${convId} (venue: ${resolvedVenue ?? 'none'}, time: ${resolvedTime ?? 'none'})`)
                  }
                }
              } catch (err) {
                console.warn(`[Agent] Step 5: Triage failed for conversation ${convId}:`, err)
              }
            }))
          }
        }

        // Dedup: triage has message-level context — it supersedes walker tasks of the same
        // type family on the same deal. REPLY/TODO → drops 'blocking'; SCHEDULE → drops 'calendar_conflict'.
        if (triageEntries.length > 0) {
          const triageRepliesOrTodos = new Set(
            triageEntries.filter(e => e.actionType !== 'SCHEDULE').map(e => e.task.dealId)
          )
          const triageSchedules = new Set(
            triageEntries.filter(e => e.actionType === 'SCHEDULE').map(e => e.task.dealId)
          )
          for (const output of walkerOutputs) {
            output.tasks = output.tasks.filter(task =>
              !(task.taskType === 'blocking'          && triageRepliesOrTodos.has(output.deal.id)) &&
              !(task.taskType === 'calendar_conflict' && triageSchedules.has(output.deal.id))
            )
          }
        }

        const scoredTasks = scoreWalkerOutput(walkerOutputs, plannerSettings, triageTasks)
        const topTasks = scoredTasks.slice(0, 20)

        // Pre-fetch existing pending actions to skip redundant LLM card generation.
        // generateCards only calls the LLM for cards that don't already exist in the DB.
        // Key by BOTH deal_id and conversation_id — triage-path actions may have deal_id=null
        // (when conversation_threads.deal_id is null), while graph walker tasks use real deal UUIDs.
        // task.dealId can be either a deal UUID or a conversation UUID (fallback), so both must match.
        const supabaseForDedup = getSupabaseAdmin()
        const { data: existingPending } = await supabaseForDedup
          .from('action_proposals')
          .select('deal_id, conversation_id, action_type')
          .eq('user_id', userId)
          .eq('status', 'pending')
        const existingDealTypes = new Set<string>()
        for (const r of existingPending ?? []) {
          if (r.deal_id) existingDealTypes.add(`${r.deal_id}:${r.action_type}`)
          if (r.conversation_id) existingDealTypes.add(`${r.conversation_id}:${r.action_type}`)
        }

        const cards = await generateCards(topTasks, plannerSettings, existingDealTypes)
        const newActions = await insertCardsAsActions(userId, cards)
        result.actionsGenerated += newActions.length
        result.actions = newActions
        result.coolingLeads = walkerOutputs.reduce(
          (n, o) => n + o.tasks.filter(t => t.taskType === 'lead_cooling').length, 0
        )
        result.coldLeads = walkerOutputs.reduce(
          (n, o) => n + o.tasks.filter(t => t.taskType === 'lead_cold').length, 0
        )
        result.followUpsGenerated = result.coolingLeads + result.coldLeads + walkerOutputs.reduce(
          (n, o) => n + o.tasks.filter(t => t.taskType === 'lead_dead').length, 0
        )
        console.log(
          `[Agent] Step 5: ${walkerOutputs.length} deals, ${scoredTasks.length} tasks, ` +
          `${cards.length} cards generated, ${newActions.length} inserted, ` +
          `${result.coolingLeads} cooling, ${result.coldLeads} cold leads`
        )

        // Clear backfill flags — graph walker finds flagged deals naturally next run
        const flagged = await getConversationsForUser(userId, { state: 'needs_proposals' })
        if (flagged.length > 0) {
          const supabase = getSupabaseAdmin()
          await supabase
            .from('conversation_threads')
            .update({ state: null })
            .in('id', flagged.map(f => f.id))
          console.log(`[Agent] Step 5: Cleared ${flagged.length} backfill flags`)
        }
      }
    } catch (plannerError) {
      console.error('[Agent] Step 5 FAILED:', plannerError instanceof Error ? plannerError.message : plannerError)
      result.errors.push(`Planner: ${plannerError instanceof Error ? plannerError.message : 'Unknown error'}`)
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
    // Collect AI usage regardless of success/failure
    const usage = getAIUsageSummary()
    result.aiUsage = usage
    if (usage.totalCalls > 0) {
      console.log(formatAIUsageTable(usage))
    }

    // Log usage to DB (non-blocking)
    if (usage.totalCalls > 0) {
      const runId = crypto.randomUUID()
      const runAt = new Date().toISOString()
      const rows: AIUsageRow[] = usage.stages.map(s => ({
        user_id: userId,
        run_id: runId,
        run_at: runAt,
        stage: s.stage,
        model: s.model,
        calls: s.calls,
        input_tokens: s.inputTokens,
        output_tokens: s.outputTokens,
        cost_usd: s.costUSD,
      }))
      try { await insertAIUsage(rows) } catch { /* never fail pipeline for logging */ }
    }

    restore()

    // Write logs to file (non-blocking, never fails the pipeline)
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const logDir = join(process.cwd(), 'logs')
      await mkdir(logDir, { recursive: true })
      const logContent = [
        `Agent run: ${userId}`,
        `Time: ${new Date().toISOString()}`,
        `Success: ${result.success}`,
        usage.totalCalls > 0 ? `AI cost: $${usage.totalCostUSD.toFixed(4)} (${usage.totalCalls} calls, ${usage.totalInputTokens} in / ${usage.totalOutputTokens} out)` : 'AI cost: $0 (no calls)',
        '',
        ...logs,
      ].join('\n')
      await writeFile(join(logDir, `agent-${ts}.log`), logContent)
    } catch { /* never fail pipeline for logging */ }
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
                  messageId: entry.message_id,
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

                if (extraction.scratchpad) {
                  console.log(`[FlowA] Scratchpad for entry ${entry.id}:\n${extraction.scratchpad}`)
                }
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
