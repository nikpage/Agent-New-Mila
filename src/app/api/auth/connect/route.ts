import { NextRequest, NextResponse } from 'next/server'
import { getUserByEmail, upsertUser } from '@/lib/db/users'
import { getAuthorizationUrl } from '@/lib/google/auth'
import { generateOAuthState } from '@/lib/auth/tokens'
import { v4 as uuidv4 } from 'uuid'

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    // Find or create user
    let user = await getUserByEmail(email)

    if (!user) {
      // Create new user
      user = await upsertUser({
        id: uuidv4(),
        email,
        email_enabled: true,
        email_unsubscribed: false,
        email_timezone: 'UTC',
      })
    }

    // Generate OAuth state with user ID
    const state = generateOAuthState(user.id)

    // Get Google OAuth URL
    const authUrl = getAuthorizationUrl(state)

    return NextResponse.json({ authUrl })
  } catch (error) {
    console.error('Error initiating OAuth:', error)
    return NextResponse.json(
      { error: 'Failed to initiate connection' },
      { status: 500 }
    )
  }
}
