/**
 * Reflection Service
 * Called at end of agent cycle (step 7).
 * Observes patterns in user behavior and writes to journal.
 */

import { runAITask } from '@/lib/ai/runner'
import {
  getRecentJournalEntries,
  findMatchingEntry,
  createJournalEntry,
  confirmObservation,
  recordConflict,
} from '@/lib/db/journal'
import { getUserSettings } from '@/lib/db/users'
import { getCPById } from '@/lib/db/counterparties'
import { getSupabaseAdmin } from '@/lib/supabase/client'
import type { JournalEntry, ActionProposal } from '@/lib/supabase/types'

// --- Types ---

export interface ReflectionInput {
  actedOnActions: {
    actionId: string
    actionType: string
    cpId: string
    cpName: string
    originalIntentCs: string | null
    finalIntentCs: string | null
    originalDraftBody: string | null
    finalDraftBody: string | null
    userAction: 'approved' | 'completed' | 'dismissed'
    editedTo: string | null
    userNotes: string | null
  }[]
  recentTimelineChanges: {
    cpId: string
    cpName: string
    eventType: string
    direction: string
    occurredAt: string
    conversationId: string | null
  }[]
  recentJournalEntries: JournalEntry[]
}

interface ReflectionObservation {
  scope: 'global' | 'cp_id' | 'conversation_id' | 'temporal'
  scope_ref: string | null
  topic: string
  content: string
  expires_at: string | null
  relation_to_existing: 'new' | 'confirming' | 'contradicting'
  existing_topic_match: string | null
}

export interface ReflectionOutput {
  observations: ReflectionObservation[]
  abstain_reason: string | null
}

export interface ProcessResult {
  created: number
  confirmed: number
  conflicted: number
}

export interface ReflectionResult {
  observationsWritten: number
  error?: string
}

// --- Gather input ---

export async function gatherReflectionInput(userId: string): Promise<ReflectionInput> {
  const settings = await getUserSettings(userId)
  const lastReflectionAt = settings.last_reflection_at

  // Get acted-on actions since last reflection
  const supabase = getSupabaseAdmin()
  let query = supabase
    .from('action_proposals')
    .select('*')
    .eq('user_id', userId)
    .in('status', ['approved', 'completed', 'dismissed'])

  if (lastReflectionAt) {
    query = query.gte('updated_at', lastReflectionAt)
  }

  const { data: actedActions, error: actionsError } = await query
  if (actionsError) {
    console.error('[Reflection] Failed to get acted-on actions:', actionsError.message)
  }

  // Build acted-on actions with CP names
  const actedOnActions = await Promise.all(
    (actedActions ?? []).map(async (action: ActionProposal) => {
      const cp = await getCPById(action.cp_id).catch(() => null)
      const payload = action.payload as Record<string, unknown> | null
      return {
        actionId: action.id,
        actionType: action.action_type,
        cpId: action.cp_id,
        cpName: cp?.name ?? 'Unknown',
        originalIntentCs: action.original_intent_cs ?? null,
        finalIntentCs: action.intent_cs ?? null,
        originalDraftBody: action.original_draft_body ?? null,
        finalDraftBody: action.draft_body_text ?? null,
        userAction: action.status as 'approved' | 'completed' | 'dismissed',
        editedTo: (payload?.editedTo as string) ?? null,
        userNotes: (payload?.userNotes as string) ?? null,
      }
    })
  )

  // Get recent timeline changes
  let timelineQuery = supabase
    .from('deal_timeline')
    .select('*')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(50)

  if (lastReflectionAt) {
    timelineQuery = timelineQuery.gte('ingested_at', lastReflectionAt)
  }

  const { data: timelineData, error: timelineError } = await timelineQuery
  if (timelineError) {
    console.error('[Reflection] Failed to get timeline changes:', timelineError.message)
  }

  // Enrich timeline with CP names
  const cpCache = new Map<string, string>()
  const recentTimelineChanges = await Promise.all(
    (timelineData ?? []).map(async (entry) => {
      let cpName = cpCache.get(entry.cp_id)
      if (!cpName) {
        const cp = await getCPById(entry.cp_id).catch(() => null)
        cpName = cp?.name ?? 'Unknown'
        cpCache.set(entry.cp_id, cpName)
      }
      return {
        cpId: entry.cp_id,
        cpName,
        eventType: entry.event_type,
        direction: entry.direction,
        occurredAt: entry.occurred_at,
        conversationId: entry.conversation_id,
      }
    })
  )

  // Get recent journal entries for context
  const recentJournalEntries = await getRecentJournalEntries(userId)

  return { actedOnActions, recentTimelineChanges, recentJournalEntries }
}

// --- Build prompt ---

function buildReflectionPrompt(input: ReflectionInput, userLanguage: string): string {
  const actedOnStr = input.actedOnActions.length > 0
    ? input.actedOnActions.map(a => {
      const parts = [
        `- ${a.actionType} for ${a.cpName} (cp_id: ${a.cpId}): user ${a.userAction}`,
      ]
      if (a.originalIntentCs && a.finalIntentCs && a.originalIntentCs !== a.finalIntentCs) {
        parts.push(`  Intent changed: "${a.originalIntentCs}" → "${a.finalIntentCs}"`)
      }
      if (a.originalDraftBody && a.finalDraftBody && a.originalDraftBody !== a.finalDraftBody) {
        parts.push(`  Draft was edited by user`)
      }
      if (a.userNotes) {
        parts.push(`  User notes: "${a.userNotes}"`)
      }
      if (a.editedTo) {
        parts.push(`  Recipient changed to: ${a.editedTo}`)
      }
      return parts.join('\n')
    }).join('\n')
    : 'No actions acted on since last cycle.'

  const timelineStr = input.recentTimelineChanges.length > 0
    ? input.recentTimelineChanges.map(t =>
      `- ${t.direction} ${t.eventType} with ${t.cpName} (cp_id: ${t.cpId}) at ${t.occurredAt}`
    ).join('\n')
    : 'No timeline changes since last cycle.'

  const journalStr = input.recentJournalEntries.length > 0
    ? input.recentJournalEntries.map(e =>
      `- [${e.type}/${e.scope}] topic="${e.topic}": ${e.content} (confirms: ${e.confirm_count}, conflicts: ${e.conflict_count})`
    ).join('\n')
    : 'No existing journal entries.'

  return `You are the reflection module for Mila, an AI agent for real estate professionals. Your job is to observe patterns in user and counterparty behaviour — not to interpret, not to evaluate, only to record facts.

CONTEXT:
You will receive:
1. Actions proposed in the previous cycle and what the user did with them
2. Recent changes in conversation timelines
3. Existing journal entries (last 7 days)

RULES:
- If in doubt, DO NOT WRITE. An empty output is correct output.
- One observation per topic per scope per cycle. Never more.
- Record only repeated or unambiguous behavioural patterns — not one-off events.
- Exception: temporal entries (approaching deadlines) should always be recorded if specific.
- Never interpret the reason behind behaviour. Only what happened.
- Label each observation as: new / confirming / contradicting (relative to existing entries).
- Always output content in ${userLanguage}, regardless of the language of input data.

INPUT:
Actions from previous cycle:
${actedOnStr}

Timeline changes:
${timelineStr}

Existing journal entries:
${journalStr}

OUTPUT — valid JSON only, no text outside it:
{
  "observations": [
    {
      "scope": "global|cp_id|conversation_id|temporal",
      "scope_ref": "<cp_id or conversation_id UUID from input data, or null for global/temporal>",
      "topic": "<short topic, max 5 words>",
      "content": "<specific observation, max 2 sentences>",
      "expires_at": "<ISO datetime or null>",
      "relation_to_existing": "new|confirming|contradicting",
      "existing_topic_match": "<topic of existing entry or null>"
    }
  ],
  "abstain_reason": "<reason for abstaining or null>"
}`
}

// --- Process output ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function processReflectionOutput(
  userId: string,
  output: ReflectionOutput
): Promise<ProcessResult> {
  const result: ProcessResult = { created: 0, confirmed: 0, conflicted: 0 }

  for (const obs of output.observations) {
    try {
      // Validate scope_ref is a UUID when scope requires one
      if (obs.scope_ref && !UUID_RE.test(obs.scope_ref)) {
        console.warn(`[Reflection] Skipping observation — invalid scope_ref "${obs.scope_ref}" (expected UUID)`)
        continue
      }

      if (obs.relation_to_existing === 'new') {
        await createJournalEntry({
          user_id: userId,
          scope: obs.scope,
          scope_ref: obs.scope_ref,
          topic: obs.topic,
          content: obs.content,
          type: 'observation',
          expires_at: obs.expires_at,
        })
        result.created++
      } else if (obs.relation_to_existing === 'confirming') {
        const existing = await findMatchingEntry(
          userId, obs.scope, obs.scope_ref,
          obs.existing_topic_match ?? obs.topic
        )
        if (existing) {
          await confirmObservation(existing.id)
          result.confirmed++
        } else {
          // No match found — create as new observation
          await createJournalEntry({
            user_id: userId,
            scope: obs.scope,
            scope_ref: obs.scope_ref,
            topic: obs.topic,
            content: obs.content,
            type: 'observation',
            expires_at: obs.expires_at,
          })
          result.created++
        }
      } else if (obs.relation_to_existing === 'contradicting') {
        const existing = await findMatchingEntry(
          userId, obs.scope, obs.scope_ref,
          obs.existing_topic_match ?? obs.topic
        )
        if (existing) {
          await recordConflict(existing.id)
          result.conflicted++
        } else {
          // No match to contradict — create as new observation
          await createJournalEntry({
            user_id: userId,
            scope: obs.scope,
            scope_ref: obs.scope_ref,
            topic: obs.topic,
            content: obs.content,
            type: 'observation',
            expires_at: obs.expires_at,
          })
          result.created++
        }
      }
    } catch (err) {
      console.error(`[Reflection] Failed to process observation "${obs.topic}":`, err)
    }
  }

  return result
}

// --- Main entry point ---

export async function runReflection(userId: string): Promise<ReflectionResult> {
  try {
    const input = await gatherReflectionInput(userId)
    const settings = await getUserSettings(userId)
    const prompt = buildReflectionPrompt(input, settings.ai_language)

    const raw = await runAITask('reflection', prompt)

    // Parse AI response
    let output: ReflectionOutput
    try {
      // Strip markdown code fences if present
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim()
      output = JSON.parse(cleaned)
    } catch {
      console.error('[Reflection] Failed to parse AI response:', raw.substring(0, 200))
      return { observationsWritten: 0, error: 'Failed to parse AI response' }
    }

    if (!output.observations || !Array.isArray(output.observations)) {
      return { observationsWritten: 0, error: 'Invalid AI response structure' }
    }

    const processResult = await processReflectionOutput(userId, output)
    const total = processResult.created + processResult.confirmed + processResult.conflicted

    console.log(`[Reflection] Processed: ${processResult.created} created, ${processResult.confirmed} confirmed, ${processResult.conflicted} conflicted`)

    return { observationsWritten: total }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[Reflection] Error:', msg)
    return { observationsWritten: 0, error: msg }
  }
}
