/**
 * Flow B — Batch Planner endpoint (Chunk 9b)
 *
 * Runs the new deal-centric pipeline:
 *   walkAllDeals → scoreWalkerOutput → generateCards
 *
 * Does NOT replace morning-brief.ts yet (that's Chunk 10).
 * This endpoint exists so Flow B can be tested and compared
 * against the old pipeline via compare-pipelines.ts before cutover.
 *
 * Auth: CRON_SECRET (same as other cron endpoints)
 *
 * Usage:
 *   GET /api/planner/run?userId=<id>
 *   Authorization: Bearer <CRON_SECRET>
 */

import { NextRequest, NextResponse } from 'next/server'
import { validateCronToken } from '@/lib/auth/tokens'
import { getUserSettings } from '@/lib/db/users'
import { walkAllDeals } from '@/services/graph-walker'
import { scoreWalkerOutput } from '@/services/scoring-engine'
import { generateCards } from '@/services/card-generator'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // 2 minutes

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')

  if (!validateCronToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = request.nextUrl.searchParams.get('userId')
  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const start = Date.now()

  try {
    // Load user settings (needed for thresholds + language)
    const settings = await getUserSettings(userId)
    if (!settings) {
      return NextResponse.json({ error: 'User not found or no settings' }, { status: 404 })
    }

    // Step 1: Graph Walker — deterministic DAG traversal
    const walkerOutputs = await walkAllDeals(userId, settings)
    const dealsFound = walkerOutputs.length
    const tasksFound = walkerOutputs.reduce((sum, o) => sum + o.tasks.length, 0)

    // Step 2: Scoring Engine — pure business rule scoring
    const scoredTasks = scoreWalkerOutput(walkerOutputs, settings)

    // Step 3: Card Generator — LLM-assisted card text (top 20 tasks)
    const topTasks = scoredTasks.slice(0, 20)
    const cards = await generateCards(topTasks, settings)
    const cardsGenerated = cards.length

    const elapsedMs = Date.now() - start

    return NextResponse.json({
      success: true,
      userId,
      dealsFound,
      tasksFound,
      cardsGenerated,
      elapsedMs,
      // Top cards for inspection/comparison
      cards: cards.slice(0, 10).map(c => ({
        dealId:       c.dealId,
        taskType:     c.taskType,
        card_type:    c.card_type,
        urgency:      c.urgency,
        score:        c.score,
        intent_cs:    c.intent_cs,
        rationale_cs: c.rationale_cs,
        placeholders: c.placeholders,
        has_draft:    c.draft_skeleton !== null,
      })),
    })
  } catch (err) {
    const elapsedMs = Date.now() - start
    console.error('[Planner] Flow B failed:', err)
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        elapsedMs,
      },
      { status: 500 }
    )
  }
}
