import { NextRequest, NextResponse } from 'next/server'
import { sendAllMorningBriefs, sendMorningBrief } from '@/services/morning-brief'
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

    if (userId) {
      console.log(`[Cron] Sending morning brief for user ${userId}`)
      const success = await sendMorningBrief(userId)
      return NextResponse.json({
        success,
        userId,
        timestamp: new Date().toISOString(),
      })
    }

    console.log('[Cron] Starting morning brief send')

    const result = await sendAllMorningBriefs()

    console.log(`[Cron] Morning briefs sent: ${result.sent}, failed: ${result.failed}`)

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[Cron] Morning brief error:', error)
    return NextResponse.json(
      { error: 'Morning brief failed' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}

