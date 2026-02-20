import { NextRequest, NextResponse } from 'next/server'
import { sendAllMorningBriefs, sendMorningBrief, type BriefType } from '@/services/morning-brief'
import { validateCronToken } from '@/lib/auth/tokens'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')

    if (!validateCronToken(token)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const userId = request.nextUrl.searchParams.get('userId')
    const typeParam = request.nextUrl.searchParams.get('type')
    const briefType: BriefType = typeParam === 'afternoon' ? 'afternoon' : 'morning'

    const start = Date.now()
    console.log(`\n[Brief] ========== Starting ${briefType} brief ==========`)
    console.log(`[Brief] Time: ${new Date().toISOString()}`)

    if (userId) {
      console.log(`[Brief] Mode: Single user — ${userId}`)
      const success = await sendMorningBrief(userId, briefType)
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`[Brief] Result: ${success ? 'sent' : 'skipped (no actions or user disabled)'}`)
      console.log(`[Brief] ========== Done (${elapsed}s) ==========\n`)
      return NextResponse.json({
        success,
        userId,
        briefType,
        timestamp: new Date().toISOString(),
      })
    }

    console.log(`[Brief] Mode: All due users`)
    const result = await sendAllMorningBriefs(briefType)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`\n[Brief] ========== Done (${elapsed}s) ==========`)
    console.log(`[Brief] Sent:   ${result.sent}`)
    console.log(`[Brief] Failed: ${result.failed}`)
    console.log(`[Brief] ==========================================\n`)

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[Brief] FAILED:', error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: 'Morning brief failed' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}

