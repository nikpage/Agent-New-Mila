import { NextRequest, NextResponse } from 'next/server'
import { updateUserGoogleTokens } from '@/lib/db/users'
import { exchangeCodeForTokens } from '@/lib/google/auth'
import { validateOAuthState } from '@/lib/auth/tokens'

export async function POST(request: NextRequest) {
  try {
    const { code, state } = await request.json()

    if (!code || !state) {
      return NextResponse.json(
        { error: 'Missing code or state' },
        { status: 400 }
      )
    }

    // Validate state and extract user ID
    const userId = validateOAuthState(state)

    if (!userId) {
      return NextResponse.json(
        { error: 'Invalid or expired state' },
        { status: 401 }
      )
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code)

    // Save tokens to database
    await updateUserGoogleTokens(userId, tokens)

    return NextResponse.json({ success: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Error completing OAuth:', msg)
    return NextResponse.json(
      { error: `Failed to complete authentication: ${msg}` },
      { status: 500 }
    )
  }
}
