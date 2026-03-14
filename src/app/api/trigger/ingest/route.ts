import { NextResponse } from 'next/server'

// 1x1 transparent GIF — route kept alive so old emails don't 404
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

export const dynamic = 'force-dynamic'

/**
 * GET /api/trigger/ingest
 * Deprecated — trigger pixel removed, ingestion now via QStash polling.
 * Returns GIF so old emails don't show broken images.
 */
export async function GET() {
  return new NextResponse(PIXEL, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}
