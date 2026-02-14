/**
 * WhatsApp Daemon
 *
 * Standalone process that connects to WhatsApp Web via whatsapp-web.js.
 * Writes incoming messages to Supabase and exposes an HTTP API for sending.
 *
 * Run with: npx tsx scripts/whatsapp-daemon.ts
 *
 * Prerequisites:
 *   npm install whatsapp-web.js qrcode-terminal
 *
 * The daemon:
 *   1. Opens a Puppeteer-driven Chrome session
 *   2. Displays a QR code for WhatsApp pairing (first run only)
 *   3. Listens for incoming messages
 *   4. Writes them to the Supabase `messages` table
 *   5. Exposes HTTP endpoints for sending messages + checking status
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { v4 as uuidv4 } from 'uuid'

// ─── Config ──────────────────────────────────────────────────────────
// These mirror src/config/client.ts but we load them directly
// since this script runs outside Next.js
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!
const USER_ID = process.env.MILA_USER_ID! // The user this daemon serves
const DAEMON_PORT = parseInt(process.env.WA_DAEMON_PORT || '3001', 10)
const SESSION_PATH = process.env.WA_SESSION_PATH || './.wwebjs_auth'

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !USER_ID) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, MILA_USER_ID')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// ─── Types ───────────────────────────────────────────────────────────
interface WAMessage {
  id: { _serialized: string }
  from: string
  to: string
  body: string
  timestamp: number
  isGroupMsg: boolean
  author?: string
  hasMedia: boolean
}

interface WAChat {
  name: string
  isGroup: boolean
}

interface WAClient {
  on(event: string, callback: (...args: unknown[]) => void): void
  initialize(): Promise<void>
  sendMessage(chatId: string, content: string): Promise<{ id: { _serialized: string } }>
  getState(): Promise<string>
  info?: { wid?: { user?: string } }
}

// ─── State ───────────────────────────────────────────────────────────
let waClient: WAClient | null = null
let isConnected = false
let lastQrCode: string | null = null
let lastMessageAt: string | null = null
let connectionError: string | null = null

// ─── Phone Number Helpers ────────────────────────────────────────────
function waIdToPhone(waId: string): string {
  // WA IDs look like "420777123456@c.us" or "420777123456@g.us" for groups
  const match = waId.match(/^(\d+)@/)
  if (!match) return waId
  return '+' + match[1]
}

function phoneToWaId(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return digits + '@c.us'
}

// ─── Supabase Helpers ────────────────────────────────────────────────
async function findOrCreateCP(phone: string, name?: string) {
  // Check if CP exists with this phone as primary identifier
  const { data: existing } = await supabase
    .from('cps')
    .select('*')
    .eq('user_id', USER_ID)
    .eq('primary_identifier', phone)
    .limit(1)
    .single()

  if (existing) return existing

  // Create new CP
  const { data: created, error } = await supabase
    .from('cps')
    .insert({
      id: uuidv4(),
      user_id: USER_ID,
      primary_identifier: phone,
      name: name || phone,
      other_identifiers: [phone],
    })
    .select()
    .single()

  if (error) {
    console.error(`[WA] Failed to create CP for ${phone}:`, error.message)
    return null
  }

  console.log(`[WA] Created new CP: ${name || phone} (${phone})`)
  return created
}

async function storeMessage(msg: WAMessage, chat: WAChat) {
  const phone = waIdToPhone(msg.from)
  const senderName = chat.isGroup ? (msg.author || phone) : (chat.name || phone)

  const cp = await findOrCreateCP(phone, senderName)
  if (!cp) return

  const messageId = uuidv4()
  const timestamp = new Date(msg.timestamp * 1000).toISOString()

  const { error } = await supabase
    .from('messages')
    .insert({
      id: messageId,
      user_id: USER_ID,
      cp_id: cp.id,
      channel_id: 'whatsapp',
      external_id: msg.id._serialized,
      external_thread_id: `wa:${phone}`, // Thread by phone number
      universal_message_id: `wa:${msg.id._serialized}`,
      direction: 'inbound',
      raw_text: msg.body,
      cleaned_text: msg.body.slice(0, 5000),
      tag_primary: 'whatsapp_message',
      tag_secondary: null,
      timestamp,
      occurred_at: timestamp,
    })

  if (error) {
    if (error.code === '23505') {
      // Duplicate — already processed
      return
    }
    console.error(`[WA] Failed to store message:`, error.message)
    return
  }

  lastMessageAt = timestamp
  console.log(`[WA] Stored message from ${senderName} (${phone}): ${msg.body.slice(0, 80)}...`)
}

// ─── WhatsApp Client Setup ──────────────────────────────────────────
async function initWhatsApp() {
  try {
    // Dynamic import — whatsapp-web.js must be installed separately
    const { Client, LocalAuth } = await import('whatsapp-web.js')

    waClient = new Client({
      authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    }) as unknown as WAClient

    waClient.on('qr', (qr: unknown) => {
      lastQrCode = qr as string
      console.log('[WA] QR code received. Scan with WhatsApp to connect.')
      // Try to display in terminal
      import('qrcode-terminal').then(qrt => {
        qrt.generate(qr as string, { small: true })
      }).catch(() => {
        console.log('[WA] Install qrcode-terminal for terminal QR display: npm i qrcode-terminal')
        console.log('[WA] Or GET http://localhost:' + DAEMON_PORT + '/status for the QR code string')
      })
    })

    waClient.on('ready', () => {
      isConnected = true
      lastQrCode = null
      connectionError = null
      const phone = (waClient as unknown as { info?: { wid?: { user?: string } } })?.info?.wid?.user
      console.log(`[WA] Connected! Phone: ${phone || 'unknown'}`)
    })

    waClient.on('disconnected', (reason: unknown) => {
      isConnected = false
      connectionError = `Disconnected: ${reason}`
      console.log(`[WA] Disconnected: ${reason}`)
    })

    waClient.on('message', async (msg: unknown) => {
      const waMsg = msg as WAMessage & { getChat: () => Promise<WAChat> }
      try {
        // Skip status messages and empty messages
        if (!waMsg.body || waMsg.from === 'status@broadcast') return

        const chat = await waMsg.getChat()

        // Skip group messages unless the group is monitored
        if (chat.isGroup) {
          // For now, skip all group messages
          // TODO: add group monitoring from client config
          return
        }

        await storeMessage(waMsg, chat)
      } catch (error) {
        console.error('[WA] Error processing message:', error)
      }
    })

    console.log('[WA] Initializing WhatsApp Web client...')
    await waClient.initialize()
  } catch (error) {
    connectionError = error instanceof Error ? error.message : 'Failed to initialize'
    console.error('[WA] Initialization failed:', error)
    console.error('[WA] Make sure whatsapp-web.js is installed: npm install whatsapp-web.js')
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

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = req.url || '/'
  const method = req.method || 'GET'

  // CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')

  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.writeHead(204)
    res.end()
    return
  }

  // GET /status — connection status
  if (url === '/status' && method === 'GET') {
    const phone = isConnected
      ? (waClient as unknown as { info?: { wid?: { user?: string } } })?.info?.wid?.user
      : undefined
    res.writeHead(200)
    res.end(JSON.stringify({
      connected: isConnected,
      qrCode: lastQrCode,
      phone: phone ? `+${phone}` : undefined,
      lastMessageAt,
      error: connectionError,
    }))
    return
  }

  // POST /send — send a message
  if (url === '/send' && method === 'POST') {
    if (!isConnected || !waClient) {
      res.writeHead(503)
      res.end(JSON.stringify({ success: false, error: 'WhatsApp not connected' }))
      return
    }

    try {
      const body = JSON.parse(await parseBody(req))
      const { to, body: msgBody } = body as { to: string; body: string }

      if (!to || !msgBody) {
        res.writeHead(400)
        res.end(JSON.stringify({ success: false, error: 'Missing "to" or "body"' }))
        return
      }

      const chatId = phoneToWaId(to)
      const sent = await waClient.sendMessage(chatId, msgBody)

      // Store outbound message in Supabase
      const cp = await findOrCreateCP(to)
      if (cp) {
        const timestamp = new Date().toISOString()
        await supabase.from('messages').insert({
          id: uuidv4(),
          user_id: USER_ID,
          cp_id: cp.id,
          channel_id: 'whatsapp',
          external_id: sent.id._serialized,
          external_thread_id: `wa:${to}`,
          universal_message_id: `wa:${sent.id._serialized}`,
          direction: 'outbound',
          raw_text: msgBody,
          cleaned_text: msgBody.slice(0, 5000),
          tag_primary: 'whatsapp_outbound',
          tag_secondary: null,
          timestamp,
          occurred_at: timestamp,
        })
      }

      res.writeHead(200)
      res.end(JSON.stringify({ success: true, messageId: sent.id._serialized }))
    } catch (error) {
      res.writeHead(500)
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Send failed',
      }))
    }
    return
  }

  // GET /health — basic health check
  if (url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, connected: isConnected }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[WA] Starting WhatsApp daemon for user ${USER_ID}`)
  console.log(`[WA] HTTP API will listen on port ${DAEMON_PORT}`)

  // Start HTTP server
  const server = createServer(handleRequest)
  server.listen(DAEMON_PORT, () => {
    console.log(`[WA] HTTP API running at http://localhost:${DAEMON_PORT}`)
    console.log(`[WA]   GET  /status  — connection status + QR code`)
    console.log(`[WA]   POST /send    — send a message { to, body }`)
    console.log(`[WA]   GET  /health  — health check`)
  })

  // Start WhatsApp client
  await initWhatsApp()

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[WA] Shutting down...')
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
