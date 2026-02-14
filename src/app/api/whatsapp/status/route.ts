import { NextResponse } from 'next/server'
import { getWhatsAppStatus } from '@/lib/whatsapp/sender'
import { clientConfig } from '@/config/client'

export const dynamic = 'force-dynamic'

/**
 * GET /api/whatsapp/status
 * Returns the WhatsApp daemon connection status.
 * Used by the dashboard to show WA connection state.
 */
export async function GET() {
  if (!clientConfig.whatsapp.enabled) {
    return NextResponse.json({
      enabled: false,
      connected: false,
      message: 'WhatsApp is disabled in client config',
    })
  }

  const status = await getWhatsAppStatus()

  return NextResponse.json({
    enabled: true,
    ...status,
  })
}
