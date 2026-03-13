import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey } from '@/lib/auth/api'
import { getUserById } from '@/lib/db/users'
import { exportAllUserData, writeAuditLog } from '@/lib/db/gdpr'

/**
 * GDPR Art. 15 — Right of Access (data export).
 * Returns a JSON object with every piece of data the system holds for the user.
 *
 * GET /api/gdpr/export?userId=<uuid>
 * Auth: x-api-key header
 */
export async function GET(request: NextRequest) {
  const authError = verifyApiKey(request)
  if (authError) return authError

  const userId = request.nextUrl.searchParams.get('userId')

  if (!userId) {
    return NextResponse.json({ error: 'userId query parameter is required' }, { status: 400 })
  }

  const user = await getUserById(userId)
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'

  await writeAuditLog({
    user_id: userId,
    action: 'gdpr_data_export',
    details: { requested_at: new Date().toISOString() },
    ip_address: ip,
  })

  try {
    const data = await exportAllUserData(userId)

    return NextResponse.json(data, {
      headers: {
        'Content-Disposition': `attachment; filename="gdpr-export-${userId}.json"`,
      },
    })
  } catch (error) {
    console.error('[GDPR] Export failed:', error)
    return NextResponse.json(
      { error: 'Export failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
