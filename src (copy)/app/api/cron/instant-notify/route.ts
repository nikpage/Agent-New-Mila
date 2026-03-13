import { NextRequest, NextResponse } from 'next/server'
import { sendInstantNotifications } from '@/services/morning-brief'
import { validateCronToken } from '@/lib/auth/tokens'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')

    if (!validateCronToken(token)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const start = Date.now()
    console.log(`\n[InstantNotify] ========== Polling for high-priority actions ==========`)
    console.log(`[InstantNotify] Time: ${new Date().toISOString()}`)

    const result = await sendInstantNotifications()
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)

    console.log(`[InstantNotify] Sent: ${result.sent}, Failed: ${result.failed}`)
    console.log(`[InstantNotify] ========== Done (${elapsed}s) ==========\n`)

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[InstantNotify] FAILED:', error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: 'Instant notification poll failed' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
