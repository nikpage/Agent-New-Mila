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
import type { WalkerTask, GraphWalkerOutput } from './graph-walker'
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
import { getUnassignedTimelineEntries } from '@/lib/db/timeline'
import { getConversationsForUser, updateConversation } from '@/lib/db/conversations'
import { getUserById, updateUserSettings, updateUserHistoryId, getUserSettings } from '@/lib/db/users'
import { getCurrentHistoryId } from '@/lib/google/gmail'
import { purgeUserAsCp } from '@/lib/db/counterparties'
import { getActiveJournalEntries, expireTemporalEntries, getCurrentBeliefs } from '@/lib/db/journal'
import { getEntitiesForDeal } from '@/lib/db/entity-map'
import { getParticipantsForDeal } from '@/lib/db/deal-participants'

import { getSupabaseAdmin } from '@/lib/supabase/client'
import type { ActionProposal, JournalEntry, UserSettings, ConversationThread } from '@/lib/supabase/types'
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
    // Walker-only pipeline: walks deal DAGs, scores tasks deterministically, generates cards via LLM.
    // Lead detection is part of the graph walker (lead_cooling / lead_cold / lead_dead tasks).
    // Triage was removed — step 4b (fact extraction + graph update) provides all context the walker needs.
    try {
      console.log(`[Agent] Step 5: Running batch planner (graph walker → scoring → cards)`)
      const plannerSettings = await getUserSettings(userId)
      if (plannerSettings) {
        const walkerOutputs = await walkAllDeals(userId, plannerSettings)

        // Inject inbound_reply tasks for conversations that received new messages this run.
        // These go through the same scoring → card generation pipeline as walker tasks.
        if (newInboundConversations && newInboundConversations.size > 0) {
          const walkerDealIndex = new Map<string, GraphWalkerOutput>()
          for (const wo of walkerOutputs) walkerDealIndex.set(wo.dealId, wo)

          for (const [convId, conv] of newInboundConversations) {
            const dealId = convDealMap.get(convId) ?? conv.deal_id
            if (!dealId) continue

            // Build entity map + belief snapshot for this deal
            let entityMapSnapshot: Record<string, string> = {}
            let beliefSnapshot: string[] = []
            let cpId: string | null = null

            // Reuse from existing walker output if available
            const existing = walkerDealIndex.get(dealId)
            if (existing && existing.tasks.length > 0) {
              entityMapSnapshot = existing.tasks[0].entityMapSnapshot
              beliefSnapshot = existing.tasks[0].beliefSnapshot
              cpId = existing.tasks[0].cpId
            } else {
              try {
                const entities = await getEntitiesForDeal(dealId)
                entityMapSnapshot = entities.reduce((acc, e) => ({
                  ...acc, [`${e.entity_type}.${e.entity_key}`]: e.entity_value,
                }), {} as Record<string, string>)
              } catch { /* empty snapshot is fine */ }
              try {
                const beliefs = await getCurrentBeliefs(dealId)
                beliefSnapshot = beliefs.map(b => b.content)
              } catch { /* empty is fine */ }
              try {
                const participants = await getParticipantsForDeal(dealId)
                cpId = participants[0]?.cp_id ?? null
              } catch { /* null is fine */ }
            }

            const task: WalkerTask = {
              nodeId: `inbound:${convId}`,
              dealId,
              taskType: 'inbound_reply',
              nodeLabel: null,
              deadline: null,
              hoursUntilDue: null,
              slack: null,
              cpId,
              entityMapSnapshot,
              beliefSnapshot,
            }

            if (existing) {
              existing.tasks.push(task)
            } else {
              // No walker output for this deal — create a minimal one.
              // The scoring engine needs a Deal object; fetch from DB.
              const supabase = getSupabaseAdmin()
              const { data: deal } = await supabase
                .from('deals')
                .select('*')
                .eq('id', dealId)
                .single()
              if (deal) {
                walkerOutputs.push({ dealId, deal, tasks: [task] })
              }
            }
          }
        }

        const scoredTasks = scoreWalkerOutput(walkerOutputs, plannerSettings)
        const topTasks = scoredTasks.slice(0, 20)

        // Pre-fetch existing pending actions to skip redundant LLM card generation.
        // All cards use real deal UUIDs — simple deal_id:action_type dedup.
        const supabaseForDedup = getSupabaseAdmin()
        const { data: existingPending } = await supabaseForDedup
          .from('action_proposals')
          .select('deal_id, action_type')
          .eq('user_id', userId)
          .eq('status', 'pending')
        const existingDealTypes = new Set<string>()
        for (const r of existingPending ?? []) {
          if (r.deal_id) existingDealTypes.add(`${r.deal_id}:${r.action_type}`)
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
    const [inboundResult, outboundResult, calendarResult] = await Promise.allSettled([
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
    if (calendarResult.status === 'fulfilled') {
      if (calendarResult.value.errors.length > 0) {
        result.errors.push(...calendarResult.value.errors)
      }
    } else {
      result.errors.push(`Calendar ingestion: ${calendarResult.reason instanceof Error ? calendarResult.reason.message : 'Unknown error'}`)
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
