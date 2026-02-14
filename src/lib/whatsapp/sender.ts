/**
 * WhatsApp Message Sender
 *
 * Sends messages via the local WhatsApp daemon's HTTP API.
 * The daemon runs as a separate process (scripts/whatsapp-daemon.ts)
 * and exposes a simple REST endpoint for sending messages.
 */

import { clientConfig } from '@/config/client'
import type { WASendRequest, WASendResponse, WAConnectionStatus } from './types'

const DAEMON_BASE_URL = `http://localhost:${clientConfig.whatsapp.daemonPort}`

/**
 * Send a WhatsApp message via the daemon.
 * Returns the send result.
 */
export async function sendWhatsAppMessage(
  to: string,
  body: string,
  replyToMessageId?: string
): Promise<WASendResponse> {
  if (!clientConfig.whatsapp.enabled) {
    return { success: false, error: 'WhatsApp is disabled in client config' }
  }

  const request: WASendRequest = { to, body, replyToMessageId }

  try {
    const response = await fetch(`${DAEMON_BASE_URL}/send`, {
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
 * Check the WhatsApp daemon connection status.
 */
export async function getWhatsAppStatus(): Promise<WAConnectionStatus> {
  if (!clientConfig.whatsapp.enabled) {
    return { connected: false, error: 'WhatsApp is disabled in client config' }
  }

  try {
    const response = await fetch(`${DAEMON_BASE_URL}/status`, {
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
