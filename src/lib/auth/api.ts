import { NextRequest, NextResponse } from 'next/server'

/**
 * Verify API key for customer deployment
 *
 * Each customer deployment has a unique CUSTOMER_API_KEY in their environment.
 * This provides basic authentication for API endpoints.
 *
 * For production multi-tenant: Replace with session-based auth (NextAuth.js)
 */
export function verifyApiKey(request: NextRequest): NextResponse | null {
  const apiKey = request.headers.get('x-api-key')
  const customerKey = process.env.CUSTOMER_API_KEY

  // In development, allow requests without key for easier testing
  if (process.env.NODE_ENV === 'development' && !customerKey) {
    console.warn('[AUTH] No CUSTOMER_API_KEY set - allowing request in development')
    return null
  }

  // In production, key is mandatory
  if (!customerKey) {
    console.error('[AUTH] CUSTOMER_API_KEY not configured - API endpoints disabled')
    return NextResponse.json(
      { error: 'API authentication not configured' },
      { status: 503 }
    )
  }

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Missing x-api-key header' },
      { status: 401 }
    )
  }

  if (apiKey !== customerKey) {
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
