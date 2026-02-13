import { NextRequest, NextResponse } from 'next/server'
import { runAgentForUser } from '@/services/agent'
import { verifyApiKey } from '@/lib/auth/api'

export const maxDuration = 300 // 5 minutes for longer processing

export async function POST(request: NextRequest) {
  // Verify API key
  const authError = verifyApiKey(request)
  if (authError) {
    return authError
  }

  try {
    const body = await request.json()
    const { userId } = body

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    }

    console.log(`[API] Running agent for user: ${userId}`)

    const result = await runAgentForUser(userId)

    return NextResponse.json(result)
  } catch (error) {
    console.error('[API] Agent run error:', error)
    return NextResponse.json(
      { error: 'Agent run failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
