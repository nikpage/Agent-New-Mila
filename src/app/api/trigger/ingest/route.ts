import { NextRequest, NextResponse } from 'next/server'
import { runAgentForUser } from '@/services/agent'
import { getUserById } from '@/lib/db/users'

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

export const dynamic = 'force-dynamic'

/**
 * GET /api/trigger/ingest?uid=<userId>
 * Tracking pixel embedded in every email Mila sends to the user.
 * When the email is opened, the email client loads this image,
 * which fires off an agent run (ingestion) for that user.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('uid')

  if (userId) {
    const user = await getUserById(userId)
    if (user) {
      // Fire and forget — don't block the pixel response
      runAgentForUser(userId).catch(err =>
        console.error(`[Trigger] Agent run failed for ${userId}:`, err)
      )
    }
  }

  return new NextResponse(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}
