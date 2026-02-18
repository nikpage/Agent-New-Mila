import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'

/**
 * Timing-safe string comparison.
 * Prevents timing attacks where an attacker measures response time
 * to deduce how many characters of the key matched.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

/**
 * Verify API key for customer deployment
 *
 * Each customer deployment has a unique MILA_USER_API_KEY in their environment.
 * This provides basic authentication for API endpoints.
 *
 * For production multi-tenant: Replace with session-based auth (NextAuth.js)
 */
export function verifyApiKey(request: NextRequest): NextResponse | null {
  const apiKey = request.headers.get('x-api-key')
  const customerKey = process.env.MILA_USER_API_KEY

  // If no key configured, allow in development, block in production
  if (!customerKey) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[AUTH] MILA_USER_API_KEY not configured in production')
      return NextResponse.json(
        { error: 'API authentication not configured' },
        { status: 503 }
      )
    }
    // Development: allow without key
    return null
  }

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Missing x-api-key header' },
      { status: 401 }
    )
  }

  if (!safeEqual(apiKey, customerKey)) {
    console.warn('[AUTH] Invalid API key attempt')
    return NextResponse.json(
      { error: 'Invalid API key' },
      { status: 403 }
    )
  }

  // Authenticated - return null to proceed
  return null
}

/**
 * Helper to extract userId from request and verify it matches authenticated user
 * For now, just extracts from request body
 * TODO: When adding session auth, verify userId matches session
 */
export async function extractUserId(request: NextRequest): Promise<string | null> {
  try {
    const body = await request.json()
    return body.userId || null
  } catch {
    return null
  }
}
