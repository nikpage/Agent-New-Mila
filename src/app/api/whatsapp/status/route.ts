import { NextRequest, NextResponse } from 'next/server'
import { getWhatsAppStatus } from '@/lib/whatsapp/sender'
import { getUserSettings } from '@/lib/db/users'

export const dynamic = 'force-dynamic'

/**
 * GET /api/whatsapp/status?userId=xxx
 * Returns the WhatsApp daemon connection status for a specific user.
 * Used by the dashboard to show WA connection state.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId')

  if (!userId) {
    return NextResponse.json(
      { error: 'userId query parameter is required' },
      { status: 400 }
    )
  }

  const settings = await getUserSettings(userId)

  if (!settings.whatsapp_enabled) {
    return NextResponse.json({
      enabled: false,
      connected: false,
      message: 'WhatsApp is disabled for this user',
    })
  }

  const status = await getWhatsAppStatus(settings)

  return NextResponse.json({
    enabled: true,
    ...status,
  })
}
