/**
 * WhatsApp Message Sender
 *
 * Sends messages via the local WhatsApp daemon's HTTP API.
 * The daemon runs as a separate process (scripts/whatsapp-daemon.ts)
 * and manages Baileys sessions per user.
 */

import type { UserSettings } from '@/lib/supabase/types'
import type { WASendRequest, WASendResponse, WAConnectionStatus } from './types'

/**
 * Send a WhatsApp message via the daemon.
 * Routes to the correct user session via userId.
 */
export async function sendWhatsAppMessage(
  userId: string,
  to: string,
  body: string,
  settings: UserSettings,
  replyToMessageId?: string
): Promise<WASendResponse> {
  if (!settings.whatsapp_enabled) {
    return { success: false, error: 'WhatsApp is disabled' }
  }

  const daemonUrl = `http://localhost:${settings.whatsapp_daemon_port}`
  const request: WASendRequest = { userId, to, body, replyToMessageId }

  try {
    const response = await fetch(`${daemonUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const text = await response.text()
      return { success: false, error: `Daemon returned ${response.status}: ${text}` }
    }

    return await response.json() as WASendResponse
  } catch (error) {
    return {
      success: false,
      error: `Failed to reach WA daemon: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/**
 * Check the WhatsApp daemon connection status for a specific user.
 */
export async function getWhatsAppStatus(userId: string, settings: UserSettings): Promise<WAConnectionStatus> {
  if (!settings.whatsapp_enabled) {
    return { connected: false, error: 'WhatsApp is disabled' }
  }

  const daemonUrl = `http://localhost:${settings.whatsapp_daemon_port}`

  try {
    const response = await fetch(`${daemonUrl}/status/${encodeURIComponent(userId)}`, {
      signal: AbortSignal.timeout(5_000),
    })

    if (!response.ok) {
      return { connected: false, error: `Daemon returned ${response.status}` }
    }

    return await response.json() as WAConnectionStatus
  } catch {
    return { connected: false, error: 'WA daemon is not running' }
  }
}
