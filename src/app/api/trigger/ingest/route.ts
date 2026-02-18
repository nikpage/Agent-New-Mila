import { NextRequest, NextResponse } from 'next/server'
import { runAgentForUser } from '@/services/agent'
import { getUserById } from '@/lib/db/users'
import { validateTriggerToken } from '@/lib/auth/tokens'

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

export const dynamic = 'force-dynamic'

const PIXEL_RESPONSE = () =>
  new NextResponse(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })

/**
 * GET /api/trigger/ingest?uid=<userId>&sig=<hmac>
 * Tracking pixel embedded in every email Mila sends to the user.
 * When the email is opened, the email client loads this image,
 * which fires off an agent run (ingestion) for that user.
 *
 * SECURITY: Requires a valid HMAC signature to prevent anyone
 * who knows a userId from triggering arbitrary agent runs.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('uid')
  const sig = request.nextUrl.searchParams.get('sig')

  // Always return the pixel — never leak whether auth failed
  if (!userId || !sig) return PIXEL_RESPONSE()

  if (!validateTriggerToken(sig, userId)) {
    console.warn(`[Trigger] Invalid signature for user ${userId}`)
    return PIXEL_RESPONSE()
  }

  const user = await getUserById(userId)
  if (user) {
    // Fire and forget — don't block the pixel response
    runAgentForUser(userId).catch(err =>
      console.error(`[Trigger] Agent run failed for ${userId}:`, err)
    )
  }

  return PIXEL_RESPONSE()
}
