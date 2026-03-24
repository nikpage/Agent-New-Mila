/**
 * WhatsApp Daemon (Baileys Multi-Session)
 *
 * Standalone process that connects to WhatsApp via Baileys (no Puppeteer).
 * Manages multiple user sessions — one WA connection per user.
 * Writes incoming messages to Supabase and exposes an HTTP API for sending.
 *
 * Run with: npx tsx scripts/whatsapp-daemon.ts
 *
 * Prerequisites:
 *   npm install @whiskeysockets/baileys pino qrcode-terminal
 *
 * Memory: ~5-10 MB per session (vs 150-300 MB with whatsapp-web.js)
 * Scales comfortably to 50-100 users on a single server.
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { v4 as uuidv4 } from 'uuid'

// ─── Config ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const DAEMON_PORT = parseInt(process.env.WA_DAEMON_PORT || '3001', 10)
const AUTH_BASE_DIR = process.env.WA_AUTH_DIR || './baileys_auth'

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// Ensure auth base directory exists
if (!existsSync(AUTH_BASE_DIR)) {
  mkdirSync(AUTH_BASE_DIR, { recursive: true })
}

// ─── Types ───────────────────────────────────────────────────────────
interface UserSession {
  userId: string
  socket: BaileysSocket | null
  isConnected: boolean
  lastQrCode: string | null
  lastMessageAt: string | null
  connectionError: string | null
  phone: string | null
  /** Prevents concurrent reconnect attempts */
  connecting: boolean
}

// Minimal Baileys types — the daemon imports the real ones at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BaileysSocket = any

// ─── Session Store ───────────────────────────────────────────────────
const sessions = new Map<string, UserSession>()

function getOrCreateSession(userId: string): UserSession {
  let session = sessions.get(userId)
  if (!session) {
    session = {
      userId,
      socket: null,
      isConnected: false,
      lastQrCode: null,
      lastMessageAt: null,
      connectionError: null,
      phone: null,
      connecting: false,
    }
    sessions.set(userId, session)
  }
  return session
}

// ─── Phone Number Helpers ────────────────────────────────────────────
function waJidToPhone(jid: string): string {
  // Baileys JIDs: "420777123456@s.whatsapp.net" or "120363...@g.us" for groups
  const match = jid.match(/^(\d+)@/)
  if (!match) return jid
  return '+' + match[1]
}

function phoneToJid(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return digits + '@s.whatsapp.net'
}

// ─── Channel Resolution ─────────────────────────────────────────────
// Cache channel UUIDs per user so we don't query on every message
const channelCache = new Map<string, string>()

async function getWhatsAppChannelId(userId: string, phone: string): Promise<string> {
  const cacheKey = `${userId}:whatsapp:${phone}`
  const cached = channelCache.get(cacheKey)
  if (cached) return cached

  // Try to find existing channel
  const { data: existing } = await supabase
    .from('channels')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'whatsapp')
    .eq('identifier', phone)
    .limit(1)
    .single()

  if (existing) {
    channelCache.set(cacheKey, existing.id)
    return existing.id
  }

  // Create new channel
  const { data: created, error } = await supabase
    .from('channels')
    .insert({ user_id: userId, type: 'whatsapp', identifier: phone })
    .select('id')
    .single()

  if (error) {
    // Race condition fallback
    if (error.code === '23505') {
      const { data: retry } = await supabase
        .from('channels')
        .select('id')
        .eq('user_id', userId)
        .eq('type', 'whatsapp')
        .eq('identifier', phone)
        .limit(1)
        .single()
      if (retry) {
        channelCache.set(cacheKey, retry.id)
        return retry.id
      }
    }
    throw new Error(`Failed to create whatsapp channel: ${error.message}`)
  }

  console.log(`[WA:${userId.slice(0, 8)}] Created WhatsApp channel for ${phone}`)
  channelCache.set(cacheKey, created.id)
  return created.id
}

// ─── Supabase Helpers ────────────────────────────────────────────────
async function findOrCreateCP(userId: string, phone: string, name?: string) {
  const { data: existing } = await supabase
    .from('cps')
    .select('*')
    .eq('user_id', userId)
    .eq('primary_identifier', phone)
    .limit(1)
    .single()

  if (existing) return existing

  const { data: created, error } = await supabase
    .from('cps')
    .insert({
      id: uuidv4(),
      user_id: userId,
      primary_identifier: phone,
      name: name || phone,
      other_identifiers: [phone],
    })
    .select()
    .single()

  if (error) {
    console.error(`[WA:${userId.slice(0, 8)}] Failed to create CP for ${phone}:`, error.message)
    return null
  }

  console.log(`[WA:${userId.slice(0, 8)}] Created new CP: ${name || phone} (${phone})`)
  return created
}

async function storeInboundMessage(
  userId: string,
  phone: string,
  senderName: string | undefined,
  messageId: string,
  body: string,
  timestamp: number
) {
  const cp = await findOrCreateCP(userId, phone, senderName)
  if (!cp) return

  const id = uuidv4()
  const ts = new Date(timestamp * 1000).toISOString()
  const channelId = await getWhatsAppChannelId(userId, phone)

  const { error } = await supabase
    .from('messages')
    .insert({
      id,
      user_id: userId,
      cp_id: cp.id,
      channel_id: channelId,
      external_id: messageId,
      external_thread_id: `wa:${phone}`,
      universal_message_id: `wa:${messageId}`,
      direction: 'inbound',
      raw_text: body,
      cleaned_text: body.slice(0, 5000),
      tag_primary: 'whatsapp_message',
      tag_secondary: null,
      timestamp: ts,
      occurred_at: ts,
    })

  if (error) {
    if (error.code === '23505') return // Duplicate — already processed
    console.error(`[WA:${userId.slice(0, 8)}] Failed to store message:`, error.message)
    return
  }

  const session = sessions.get(userId)
  if (session) session.lastMessageAt = ts
  console.log(`[WA:${userId.slice(0, 8)}] Stored message from ${senderName || phone}: ${body.slice(0, 80)}...`)
}

async function storeOutboundMessage(
  userId: string,
  phone: string,
  messageId: string,
  body: string
) {
  const cp = await findOrCreateCP(userId, phone)
  if (!cp) return

  const ts = new Date().toISOString()
  const channelId = await getWhatsAppChannelId(userId, phone)

  await supabase.from('messages').insert({
    id: uuidv4(),
    user_id: userId,
    cp_id: cp.id,
    channel_id: channelId,
    external_id: messageId,
    external_thread_id: `wa:${phone}`,
    universal_message_id: `wa:${messageId}`,
    direction: 'outbound',
    raw_text: body,
    cleaned_text: body.slice(0, 5000),
    tag_primary: 'whatsapp_outbound',
    tag_secondary: null,
    timestamp: ts,
    occurred_at: ts,
  })
}

// ─── Message Text Extraction ────────────────────────────────────
// Extracts readable text from any WhatsApp message type.
// If a message has no text (e.g. image without caption), returns a bracket placeholder
// so Mila knows something was sent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMessageText(m: any): string | null {
  // Plain text
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text

  // Media with captions
  if (m.imageMessage) return m.imageMessage.caption || '[Image]'
  if (m.videoMessage) return m.videoMessage.caption || '[Video]'
  if (m.documentMessage) {
    const caption = m.documentMessage.caption
    const filename = m.documentMessage.fileName
    if (caption) return caption
    if (filename) return `[Document: ${filename}]`
    return '[Document]'
  }
  if (m.audioMessage) return '[Voice message]'

  // Contact shared
  if (m.contactMessage) {
    const name = m.contactMessage.displayName || 'Unknown'
    const vcard = m.contactMessage.vcard || ''
    const telMatch = vcard.match(/TEL[^:]*:([^\n]+)/)
    const phone = telMatch ? telMatch[1].trim() : ''
    return `[Contact: ${name}${phone ? ' ' + phone : ''}]`
  }
  if (m.contactsArrayMessage) {
    const names = (m.contactsArrayMessage.contacts || [])
      .map((c: { displayName?: string }) => c.displayName || 'Unknown')
      .join(', ')
    return `[Contacts: ${names}]`
  }

  // Location
  if (m.locationMessage) {
    const loc = m.locationMessage
    const name = loc.name || loc.address || ''
    const coords = loc.degreesLatitude && loc.degreesLongitude
      ? `${loc.degreesLatitude},${loc.degreesLongitude}`
      : ''
    return `[Location: ${name || coords || 'shared'}]`
  }
  if (m.liveLocationMessage) return '[Live location]'

  // Business/template messages
  if (m.templateMessage) {
    const hydratedTemplate = m.templateMessage.hydratedTemplate
      || m.templateMessage.hydratedFourRowTemplate
    if (hydratedTemplate) {
      return hydratedTemplate.hydratedContentText
        || hydratedTemplate.hydratedTitleText
        || '[Template message]'
    }
    return '[Template message]'
  }

  // Button messages
  if (m.buttonsMessage) return m.buttonsMessage.contentText || '[Button message]'
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedDisplayText || '[Button response]'

  // List messages
  if (m.listMessage) return m.listMessage.description || m.listMessage.title || '[List message]'
  if (m.listResponseMessage) {
    const sel = m.listResponseMessage.singleSelectReply
    return sel?.selectedRowId || m.listResponseMessage.title || '[List response]'
  }

  // Polls
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const poll = m.pollCreationMessage || m.pollCreationMessageV3
    return `[Poll: ${poll.name || 'untitled'}]`
  }

  // Edited messages — unwrap and re-extract
  if (m.editedMessage?.message) return extractMessageText(m.editedMessage.message)

  // View-once — unwrap and re-extract
  if (m.viewOnceMessage?.message) return extractMessageText(m.viewOnceMessage.message)
  if (m.viewOnceMessageV2?.message) return extractMessageText(m.viewOnceMessageV2.message)

  // Ephemeral wrapper — unwrap and re-extract
  if (m.ephemeralMessage?.message) return extractMessageText(m.ephemeralMessage.message)

  return null
}

// ─── Baileys Session Management ──────────────────────────────────────
async function connectUser(userId: string): Promise<void> {
  const session = getOrCreateSession(userId)

  if (session.connecting) {
    console.log(`[WA:${userId.slice(0, 8)}] Already connecting, skipping...`)
    return
  }

  session.connecting = true

  try {
    // Dynamic imports — baileys must be installed separately
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
      await import('@whiskeysockets/baileys')
    const pino = (await import('pino')).default

    const authDir = join(AUTH_BASE_DIR, userId)
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    const logger = pino({ level: 'silent' }) // Suppress Baileys internal logs

    const socket = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false, // We handle QR via HTTP API
      // Reduce memory: don't cache messages in memory
      getMessage: async () => undefined,
    })

    session.socket = socket

    // ── Auth credentials update ──
    socket.ev.on('creds.update', saveCreds)

    // ── Connection status ──
    socket.ev.on('connection.update', (update: { connection?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } }; qr?: string }) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        session.lastQrCode = qr
        session.isConnected = false
        console.log(`[WA:${userId.slice(0, 8)}] QR code generated — scan to connect`)

        // Try to display in terminal (single-user dev convenience)
        import('qrcode-terminal').then(qrt => {
          const mod = qrt.default || qrt
          mod.generate(qr, { small: true })
        }).catch(() => {
          // qrcode-terminal not installed — that's fine, use HTTP API
        })
      }

      if (connection === 'open') {
        session.isConnected = true
        session.lastQrCode = null
        session.connectionError = null
        session.connecting = false

        // Extract phone number from socket
        const me = socket.user
        session.phone = me?.id ? waJidToPhone(me.id) : null
        console.log(`[WA:${userId.slice(0, 8)}] Connected! Phone: ${session.phone || 'unknown'}`)
      }

      if (connection === 'close') {
        session.isConnected = false
        session.connecting = false

        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        if (shouldReconnect) {
          session.connectionError = `Disconnected (code ${statusCode}), reconnecting...`
          console.log(`[WA:${userId.slice(0, 8)}] ${session.connectionError}`)
          // Reconnect after a brief delay
          setTimeout(() => connectUser(userId), 3000)
        } else {
          session.connectionError = 'Logged out — re-scan QR code to reconnect'
          session.socket = null
          console.log(`[WA:${userId.slice(0, 8)}] Logged out. Remove auth and re-pair.`)
        }
      }
    })

    // ── Incoming messages ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    socket.ev.on('messages.upsert', async (upsert: { messages: any[] }) => {
      for (const msg of upsert.messages) {
        try {
          const jid = msg.key?.remoteJid
          if (!jid) continue

          // Skip own outbound messages
          if (msg.key.fromMe) continue

          // Skip status broadcasts
          if (jid === 'status@broadcast') continue

          // Skip group messages (for now)
          if (jid.endsWith('@g.us')) continue

          const m = msg.message
          if (!m) continue

          // Skip protocol/encryption internals — no user value
          if (m.protocolMessage || m.senderKeyDistributionMessage) continue
          // Skip reactions and stickers — no actionable text
          if (m.reactionMessage || m.stickerMessage) continue

          // Extract text from all message types that carry readable content
          const body = extractMessageText(m)
          if (!body) continue

          const phone = waJidToPhone(jid)
          const messageId = msg.key.id || uuidv4()
          const timestamp = typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp
            : Math.floor(Date.now() / 1000)

          await storeInboundMessage(
            userId,
            phone,
            msg.pushName || undefined,
            messageId,
            body,
            timestamp
          )
        } catch (error) {
          console.error(`[WA:${userId.slice(0, 8)}] Error processing message:`, error)
        }
      }
    })

  } catch (error) {
    session.connectionError = error instanceof Error ? error.message : 'Failed to initialize'
    session.connecting = false
    console.error(`[WA:${userId.slice(0, 8)}] Init failed:`, error)
    console.error(`[WA] Make sure Baileys is installed: npm install @whiskeysockets/baileys pino`)
  }
}

// ─── Load Existing Sessions on Startup ───────────────────────────────
async function loadExistingSessions() {
  // Reconnect any users that have saved auth state
  if (!existsSync(AUTH_BASE_DIR)) return

  const userDirs = readdirSync(AUTH_BASE_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  if (userDirs.length === 0) {
    console.log('[WA] No existing sessions found. Use POST /sessions/:userId/connect to add users.')
    return
  }

  console.log(`[WA] Found ${userDirs.length} existing session(s), reconnecting...`)

  for (const userId of userDirs) {
    // Stagger reconnections to avoid hammering WA servers
    await connectUser(userId)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

// ─── HTTP API ────────────────────────────────────────────────────────
function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url || '/'
  const method = req.method || 'GET'

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  // ── GET /health ──
  if (url === '/health') {
    const connectedCount = Array.from(sessions.values()).filter(s => s.isConnected).length
    jsonResponse(res, 200, { ok: true, sessions: sessions.size, connected: connectedCount })
    return
  }

  // ── GET /sessions ── list all sessions
  if (url === '/sessions' && method === 'GET') {
    const list = Array.from(sessions.values()).map(s => ({
      userId: s.userId,
      connected: s.isConnected,
      phone: s.phone,
      lastMessageAt: s.lastMessageAt,
      hasQr: !!s.lastQrCode,
      error: s.connectionError,
    }))
    jsonResponse(res, 200, { sessions: list })
    return
  }

  // ── GET /status/:userId ── single session status
  const statusMatch = url.match(/^\/status\/([^/]+)$/)
  if (statusMatch && method === 'GET') {
    const userId = statusMatch[1]
    const session = sessions.get(userId)

    if (!session) {
      jsonResponse(res, 404, { connected: false, error: 'No session for this user' })
      return
    }

    jsonResponse(res, 200, {
      connected: session.isConnected,
      qrCode: session.lastQrCode,
      phone: session.phone,
      lastMessageAt: session.lastMessageAt,
      error: session.connectionError,
    })
    return
  }

  // ── GET /status ── backward compat (returns first session or empty)
  if (url === '/status' && method === 'GET') {
    const firstSession = sessions.values().next().value as UserSession | undefined
    if (!firstSession) {
      jsonResponse(res, 200, { connected: false, error: 'No sessions configured' })
      return
    }
    jsonResponse(res, 200, {
      connected: firstSession.isConnected,
      qrCode: firstSession.lastQrCode,
      phone: firstSession.phone,
      lastMessageAt: firstSession.lastMessageAt,
      error: firstSession.connectionError,
    })
    return
  }

  // ── POST /sessions/:userId/connect ── start a new session
  const connectMatch = url.match(/^\/sessions\/([^/]+)\/connect$/)
  if (connectMatch && method === 'POST') {
    const userId = connectMatch[1]
    const session = sessions.get(userId)

    if (session?.isConnected) {
      jsonResponse(res, 200, { status: 'already_connected', phone: session.phone })
      return
    }

    // Start connection in background
    connectUser(userId).catch(err => {
      console.error(`[WA:${userId.slice(0, 8)}] Connect error:`, err)
    })

    jsonResponse(res, 202, { status: 'connecting', message: 'GET /status/' + userId + ' for QR code' })
    return
  }

  // ── DELETE /sessions/:userId ── disconnect and remove session
  const disconnectMatch = url.match(/^\/sessions\/([^/]+)$/)
  if (disconnectMatch && method === 'DELETE') {
    const userId = disconnectMatch[1]
    const session = sessions.get(userId)

    if (session?.socket) {
      session.socket.end(undefined)
      session.socket = null
    }
    sessions.delete(userId)
    jsonResponse(res, 200, { status: 'disconnected' })
    return
  }

  // ── POST /send ── send a message
  if (url === '/send' && method === 'POST') {
    try {
      const body = JSON.parse(await parseBody(req))
      const { userId, to, body: msgBody } = body as { userId?: string; to: string; body: string }

      if (!to || !msgBody) {
        jsonResponse(res, 400, { success: false, error: 'Missing "to" or "body"' })
        return
      }

      // Find the session — use explicit userId, or fall back to first connected session
      let session: UserSession | undefined
      if (userId) {
        session = sessions.get(userId)
      } else {
        // Backward compat: pick first connected session
        session = Array.from(sessions.values()).find(s => s.isConnected)
      }

      if (!session || !session.isConnected || !session.socket) {
        jsonResponse(res, 503, { success: false, error: 'WhatsApp not connected for this user' })
        return
      }

      const jid = phoneToJid(to)
      const sent = await session.socket.sendMessage(jid, { text: msgBody })
      const sentId = sent?.key?.id || uuidv4()

      // Store outbound message in Supabase
      await storeOutboundMessage(session.userId, to, sentId, msgBody)

      jsonResponse(res, 200, { success: true, messageId: sentId })
    } catch (error) {
      jsonResponse(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : 'Send failed',
      })
    }
    return
  }

  jsonResponse(res, 404, { error: 'Not found' })
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('[WA] Starting WhatsApp daemon (Baileys multi-session)')
  console.log(`[WA] Auth directory: ${AUTH_BASE_DIR}`)
  console.log(`[WA] HTTP API will listen on port ${DAEMON_PORT}`)

  // Start HTTP server
  const server = createServer(handleRequest)
  server.listen(DAEMON_PORT, () => {
    console.log(`[WA] HTTP API running at http://localhost:${DAEMON_PORT}`)
    console.log(`[WA]   GET  /health                      — health check`)
    console.log(`[WA]   GET  /sessions                    — list all sessions`)
    console.log(`[WA]   GET  /status/:userId              — session status + QR code`)
    console.log(`[WA]   POST /sessions/:userId/connect    — start/reconnect session`)
    console.log(`[WA]   DELETE /sessions/:userId          — disconnect session`)
    console.log(`[WA]   POST /send { userId, to, body }   — send a message`)
  })

  // Reconnect existing sessions
  await loadExistingSessions()

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[WA] Shutting down all sessions...')
    for (const session of sessions.values()) {
      if (session.socket) {
        try { session.socket.end(undefined) } catch { /* ignore */ }
      }
    }
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(error => {
  console.error('[WA] Fatal error:', error)
  process.exit(1)
})
