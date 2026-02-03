import { NextRequest, NextResponse } from 'next/server'
import { sendAllMorningBriefs } from '@/services/morning-brief'
import { validateCronToken } from '@/lib/auth/tokens'

export const maxDuration = 300 // 5 minutes

export async function GET(request: NextRequest) {
  try {
    // Validate cron secret
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')

    if (!token || !validateCronToken(token)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
      { error: 'Morning brief failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// Also support POST for flexibility
export async function POST(request: NextRequest) {
  return GET(request)
}
