#!/usr/bin/env npx tsx
/**
 * E2E Pipeline Test — Interactive Multi-Round Conversation
 *
 * Flow:
 *   1. Inject all CP emails (3 regular + 1 urgent) → run agent → actions
 *   2. Instant-notify fires for urgent ones
 *   3. Print action URLs → YOU interact in browser (UDĚLAT, UPRAVIT, etc.)
 *   4. Press Enter when done
 *   5. Script reads Mila's actual replies from Gmail
 *   6. Script generates tailored CP responses based on what Mila wrote
 *   7. Inject those → run agent → new actions from follow-ups
 *   8. Print Round 2 action URLs → YOU interact again
 *   9. Enter → morning brief with full real conversation history
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts [userId]
 *
 * Flags:
 *   --skip-inject     Skip email injection (re-run agent on existing mail)
 *   --skip-brief      Skip morning brief step
 *   --single-round    Only run Round 1 + interact, skip Round 2
 *   --cleanup-only    Delete previously injected test emails and exit
 *   --prod            Use production URL (https://mila.specialagents.pro)
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import * as readline from 'readline'
import { google, gmail_v1 } from 'googleapis'
import { getAuthenticatedClient } from '../src/lib/google/auth'
import { generateActionToken } from '../src/lib/auth/tokens'
import { runAITask } from '../src/lib/ai/runner'

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const positional = args.filter(a => !a.startsWith('--'))

const USER_ID = positional[0] || '9e59bc06-7276-453d-bc2e-f224a0a327e3'
let BASE_URL = flags.has('--prod')
  ? 'https://mila.specialagents.pro'
  : (process.env.E2E_BASE_URL || process.env.APP_BASE_URL || '')
const API_KEY = process.env.MILA_USER_API_KEY || ''
const CRON_SECRET = process.env.CRON_SECRET || ''

/** Auto-detect dev server port if no explicit URL set */
async function detectBaseUrl(): Promise<string> {
  if (BASE_URL) return BASE_URL
  for (const port of [3000, 3001, 3002]) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        console.log(`  Auto-detected dev server on port ${port}`)
        return `http://localhost:${port}`
      }
    } catch { /* not listening */ }
  }
  return 'http://localhost:3000'
}

const TEST_MARKER = 'E2E-TEST'
const RUN_ID = `${TEST_MARKER}-${Date.now()}`

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1] : from
}

function extractName(from: string): string {
  const match = from.match(/^([^<]+)\s*</)
  return match ? match[1].trim() : from
}

// ─── Test Scenarios ──────────────────────────────────────────────────────────

interface TestEmail {
  cpKey: string
  from: string
  subject: string
  body: string
}

const TEST_EMAILS: TestEmail[] = [
  {
    cpKey: 'bob',
    from: 'Bob <ainikpage+Bob@gmail.com>',
    subject: `[${RUN_ID}] Property inquiry from Bob`,
    body: [
      'Hi,',
      '',
      'I saw your Prague listing for the apartment on Vinohradska 45. Is it still available?',
      'I would like to schedule a viewing this week if possible.',
      '',
      'My budget is around 8,500,000 CZK. Is there room for negotiation?',
      '',
      'Thanks,',
      'Bob',
    ].join('\n'),
  },
  {
    cpKey: 'eva',
    from: 'Eva Dvorakova <ainikpage+dvorakova.eva@gmail.com>',
    subject: `[${RUN_ID}] Follow-up on Karlin office lease`,
    body: [
      'Dobry den,',
      '',
      'We spoke last week about the office space in Karlin, 200m2.',
      'Our company is ready to sign a 3-year lease at 450 CZK/m2/month.',
      '',
      'Can we finalize the contract tomorrow morning at around 9 or 10? We need to move in by April.',
      '',
      'Dekuji,',
      'Eva Dvorakova',
      'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  {
    cpKey: 'martin',
    from: 'Martin Kral <ainikpage+kral.martin@gmail.com>',
    subject: `[${RUN_ID}] Urgent: Closing date moved up`,
    body: [
      'Hi,',
      '',
      'The seller of the Smichov property wants to close by April instead of May.',
      'Purchase price 12,400,000 CZK as agreed.',
      '',
      'Can you confirm the financing is ready? The bank needs the signed documents by Friday.',
      '',
      'This is time-sensitive — please respond today if possible.',
      '',
      'Martin Kral',
    ].join('\n'),
  },
]

const HIGH_PRIORITY_EMAIL: TestEmail = {
  cpKey: 'urgent',
  from: 'Jan Novotny <ainikpage+novotny.jan@gmail.com>',
  subject: `[${RUN_ID}] URGENT: 45M CZK deal — notary signing tomorrow morning`,
  body: [
    'URGENTNÍ — NUTNÁ OKAMŽITÁ ODPOVĚĎ',
    '',
    'The buyer for the Vinohrady commercial building has confirmed 45,000,000 CZK.',
    'The notary appointment is TOMORROW at 9:00 AM at Třinecká 672, Praha.',
    '',
    'We need your confirmation TODAY by 5pm or the deal falls through.',
    'The buyer has another property lined up and will walk away.',
    '',
    'Documents required:',
    '- Signed purchase agreement',
    '- Power of attorney (original)',
    '- Proof of financing from the bank',
    '',
    'This is the largest deal this quarter. Please respond IMMEDIATELY.',
    '',
    'Jan Novotný',
    'Senior Broker, Prague Commercial',
    'Třinecká 672, Praha',
  ].join('\n'),
}

const ALL_TEST_SENDERS = [...TEST_EMAILS, HIGH_PRIORITY_EMAIL]
const TEST_CP_EMAILS = ALL_TEST_SENDERS.map(e => extractEmail(e.from))

// ─── CP Response Profiles (adaptive, not canned) ────────────────────────────

const CP_RESPONSE_PROFILES: Record<string, { persona: string; context: string; guidance: string }> = {
  bob: {
    persona: 'Bob, a potential apartment buyer',
    context: 'Interested in Prague apartment on Vinohradska 45, budget ~8.5M CZK',
    guidance: 'If Mila proposed a viewing time, confirm it and ask to bring your wife. Ask about parking. If she answered the price question, react to it.',
  },
  eva: {
    persona: 'Eva Dvorakova, representing Dvorak & Partners s.r.o.',
    context: 'Negotiating a 3-year lease for 200m2 office in Karlin at 450 CZK/m2/month. Need to move in by April.',
    guidance: 'Confirm 450 CZK/m2 is your final offer. If a meeting was proposed, agree. Ask about 3 dedicated parking spots for COO, CFO, and company car.',
  },
  martin: {
    persona: 'Martin Kral, handling the Smichov property purchase',
    context: 'Purchase price 12.4M CZK, seller wants to close by April. Bank needs signed docs by Friday.',
    guidance: 'Confirm bank approved financing and all docs are signed. Ask about notary appointment. Available Monday-Wednesday next week, mornings preferred.',
  },
  urgent: {
    persona: 'Jan Novotny, senior broker at Prague Commercial',
    context: '45M CZK Vinohrady commercial building deal, notary appointment tomorrow 9 AM.',
    guidance: 'Acknowledge whatever Mila confirmed. Press for exact document delivery timing. Remind the buyer has another property lined up. Keep urgency high.',
  },
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface InjectedEmail {
  gmailId: string
  threadId: string
  cpKey: string
  from: string
  subject: string
  rfcMessageId: string
}

interface ActionProposal {
  id: string
  user_id: string
  conversation_id: string
  cp_id: string
  action_type: string
  status: string
  intent_cs: string | null
  rationale: string
  priority_score: number
  urgency: number
  dollar_value: number
  payload: Record<string, unknown>
}

interface AgentResult {
  success: boolean
  emailsIngested: number
  calendarEventsSynced: number
  messagesProcessed: number
  conversationsUpdated: number
  actionsGenerated: number
  followUpsGenerated: number
  coolingLeads: number
  coldLeads: number
  actions: ActionProposal[]
  errors: string[]
}

interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

interface MilaReply {
  cpKey: string
  cpEmail: string
  body: string
  subject: string
  threadId: string
  messageId: string
  gmailId: string
}

interface InstantNotifyResult {
  success: boolean
  sent: number
  failed: number
  timestamp: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(step: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] [${step}] ${msg}`)
}

function fail(step: string, msg: string): never {
  log(step, `FAIL: ${msg}`)
  process.exit(1)
}

async function api(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; timeout?: number } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout || 300_000)
  init.signal = controller.signal

  const res = await fetch(url, init)
  clearTimeout(timer)

  const ct = res.headers.get('content-type') || ''
  const body = ct.includes('json') ? await res.json() : { text: await res.text() }
  return { status: res.status, body: body as Record<string, unknown> }
}

let _gmailClient: gmail_v1.Gmail | null = null
let _userEmail: string = ''

async function getGmailClient(userId: string): Promise<gmail_v1.Gmail> {
  if (_gmailClient) return _gmailClient
  const auth = await getAuthenticatedClient(userId)
  _gmailClient = google.gmail({ version: 'v1', auth })
  return _gmailClient
}

async function getUserEmail(userId: string): Promise<string> {
  if (_userEmail) return _userEmail
  const gmail = await getGmailClient(userId)
  const profile = await gmail.users.getProfile({ userId: 'me' })
  _userEmail = profile.data.emailAddress || ''
  return _userEmail
}

function encodeRaw(rfc2822: string): string {
  return Buffer.from(rfc2822)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function printChecks(checks: CheckResult[]): boolean {
  let allPassed = true
  for (const check of checks) {
    const icon = check.pass ? '✓' : '✗'
    log('verify', `  ${icon} ${check.name}: ${check.detail}`)
    if (!check.pass) allPassed = false
  }
  return allPassed
}

async function waitForKeypress(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(prompt, () => {
      rl.close()
      resolve()
    })
  })
}

function getHeaderValue(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || ''
}

function extractMessageBody(message: gmail_v1.Schema$Message): string {
  const payload = message.payload
  if (!payload) return ''

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8')
          .replace(/<[^>]+>/g, '')
      }
    }
  }

  return ''
}

// ─── Inject emails ──────────────────────────────────────────────────────────

async function injectEmails(userId: string, emails: TestEmail[]): Promise<InjectedEmail[]> {
  log('inject', `Injecting ${emails.length} emails into inbox...`)

  const gmail = await getGmailClient(userId)
  const userEmail = await getUserEmail(userId)
  const injected: InjectedEmail[] = []

  for (const email of emails) {
    const rfcMessageId = `<${RUN_ID}-${injected.length}@e2e-test.local>`
    const rfc2822 = [
      `From: ${email.from}`,
      `To: ${userEmail}`,
      `Subject: ${email.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${rfcMessageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      email.body,
    ].join('\r\n')

    const res = await gmail.users.messages.insert({
      userId: 'me',
      requestBody: { raw: encodeRaw(rfc2822), labelIds: ['INBOX', 'UNREAD'] },
      internalDateSource: 'dateHeader',
    })

    injected.push({
      gmailId: res.data.id || 'unknown',
      threadId: res.data.threadId || 'unknown',
      cpKey: email.cpKey,
      from: email.from,
      subject: email.subject,
      rfcMessageId,
    })
    log('inject', `  ✓ "${email.subject.replace(`[${RUN_ID}] `, '')}" → ${res.data.id} (thread: ${res.data.threadId})`)
  }

  log('inject', `Injected ${injected.length} emails. Waiting 3s for Gmail indexing...`)
  await new Promise(r => setTimeout(r, 3000))

  return injected
}

// ─── Run agent pipeline ─────────────────────────────────────────────────────

async function runAgent(userId: string, roundLabel: string): Promise<AgentResult> {
  log(`${roundLabel}:agent`, `Triggering agent run at ${BASE_URL}...`)

  const { status, body } = await api('POST', '/api/agent/run', {
    headers: { 'x-api-key': API_KEY },
    body: { userId },
    timeout: 300_000,
  })

  if (status !== 200) {
    fail(`${roundLabel}:agent`, `HTTP ${status}: ${JSON.stringify(body)}`)
  }

  const result = body as unknown as AgentResult
  if (!result.success) {
    fail(`${roundLabel}:agent`, `Agent returned success=false: ${JSON.stringify(result.errors)}`)
  }

  log(`${roundLabel}:agent`, `Results:`)
  log(`${roundLabel}:agent`, `  Emails ingested:       ${result.emailsIngested}`)
  log(`${roundLabel}:agent`, `  Calendar synced:       ${result.calendarEventsSynced}`)
  log(`${roundLabel}:agent`, `  Messages processed:    ${result.messagesProcessed}`)
  log(`${roundLabel}:agent`, `  Conversations updated: ${result.conversationsUpdated}`)
  log(`${roundLabel}:agent`, `  Actions generated:     ${result.actionsGenerated}`)
  log(`${roundLabel}:agent`, `  Follow-ups:            ${result.followUpsGenerated}`)
  if (result.actions?.length) {
    log(`${roundLabel}:agent`, `  Action details:`)
    for (const a of result.actions) {
      log(`${roundLabel}:agent`, `    - [${a.action_type}] ${a.intent_cs || a.rationale} (score: ${a.priority_score}, urgency: ${a.urgency})`)
    }
  }
  if (result.errors?.length) {
    log(`${roundLabel}:agent`, `  Errors: ${result.errors.join(', ')}`)
  }

  return result
}

// ─── Print action URLs for browser interaction ──────────────────────────────

function printActionUrls(actions: ActionProposal[], userId: string): void {
  if (!actions.length) {
    log('actions', 'No actions to interact with')
    return
  }

  const sorted = [...actions].sort((a, b) => b.urgency - a.urgency || b.priority_score - a.priority_score)

  console.log()
  console.log('  ┌─────────────────────────────────────────────────────────┐')
  console.log('  │  ACTION URLS — open in browser, click UDĚLAT / UPRAVIT │')
  console.log('  └─────────────────────────────────────────────────────────┘')
  console.log()

  for (const action of sorted) {
    const token = generateActionToken(action.id, userId)
    const detailUrl = `${BASE_URL}/action/${action.id}?token=${token}&view=details`
    const executeUrl = `${BASE_URL}/action/${action.id}?token=${token}&do=execute&type=${action.action_type}`
    const editUrl = `${BASE_URL}/action/${action.id}/edit?token=${token}`

    const urgencyTag = action.urgency >= 9 ? ' ⚡URGENT' : ''
    console.log(`  [${action.action_type}] ${action.intent_cs || action.rationale}${urgencyTag}`)
    console.log(`    Score: ${action.priority_score} | Urgency: ${action.urgency} | Value: ${action.dollar_value}`)
    console.log(`    UDĚLAT:  ${executeUrl}`)
    console.log(`    UPRAVIT: ${editUrl}`)
    console.log(`    Detail:  ${detailUrl}`)
    console.log()
  }
}

// ─── Scan Gmail for Mila's actual sent replies ──────────────────────────────

async function scanMilaReplies(userId: string): Promise<Map<string, MilaReply>> {
  log('scan', 'Scanning Gmail SENT for Mila\'s replies to test CPs...')

  const gmail = await getGmailClient(userId)
  const replies = new Map<string, MilaReply>()

  for (const testEmail of ALL_TEST_SENDERS) {
    const cpEmail = extractEmail(testEmail.from)
    const q = `in:sent to:${cpEmail} subject:${TEST_MARKER}`

    const list = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 5,
    })

    if (!list.data.messages?.length) {
      log('scan', `  - No reply found for ${testEmail.cpKey} (${cpEmail})`)
      continue
    }

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: list.data.messages[0].id!,
      format: 'full',
    })

    const body = extractMessageBody(msg.data)
    const subject = getHeaderValue(msg.data, 'Subject')
    const messageId = getHeaderValue(msg.data, 'Message-ID')

    replies.set(testEmail.cpKey, {
      cpKey: testEmail.cpKey,
      cpEmail,
      body,
      subject,
      threadId: msg.data.threadId || '',
      messageId,
      gmailId: msg.data.id || '',
    })

    log('scan', `  ✓ Found Mila's reply to ${testEmail.cpKey}: "${subject.slice(0, 60)}"`)
  }

  log('scan', `Found ${replies.size} Mila replies out of ${ALL_TEST_SENDERS.length} CPs`)
  return replies
}

// ─── Generate tailored CP response using AI ─────────────────────────────────

async function generateTailoredCPResponse(
  cpKey: string,
  milaReplyBody: string,
  originalEmail: TestEmail
): Promise<string> {
  const profile = CP_RESPONSE_PROFILES[cpKey]
  if (!profile) return ''

  const prompt = [
    `You are ${profile.persona}.`,
    `Context: ${profile.context}`,
    '',
    `You originally sent this email:`,
    `"${originalEmail.body}"`,
    '',
    `You received this reply from the real estate agent's assistant (Mila):`,
    `"${milaReplyBody}"`,
    '',
    `Write a realistic follow-up email response.`,
    profile.guidance,
    '',
    `Rules:`,
    `- Write 3-8 lines, natural and conversational`,
    `- Reference specific details from Mila's reply`,
    `- Sign off as ${extractName(originalEmail.from)}`,
    `- Mix Czech and English naturally (this is Prague business)`,
    `- Do NOT include subject line, just the body text`,
  ].join('\n')

  log('ai', `  Generating ${cpKey}'s response...`)
  const result = await runAITask('drafting', prompt)
  return result.trim()
}

// ─── Inject tailored CP responses ───────────────────────────────────────────

async function injectTailoredCPResponses(
  userId: string,
  injected: InjectedEmail[],
  milaReplies: Map<string, MilaReply>
): Promise<string[]> {
  log('respond', 'Generating and injecting tailored CP responses...')

  const gmail = await getGmailClient(userId)
  const userEmail = await getUserEmail(userId)
  const responseIds: string[] = []

  for (const original of injected) {
    const milaReply = milaReplies.get(original.cpKey)
    if (!milaReply) {
      log('respond', `  - No Mila reply for ${original.cpKey}, skipping`)
      continue
    }

    const originalTestEmail = ALL_TEST_SENDERS.find(e => e.cpKey === original.cpKey)
    if (!originalTestEmail) continue

    const responseBody = await generateTailoredCPResponse(
      original.cpKey,
      milaReply.body,
      originalTestEmail
    )

    if (!responseBody) {
      log('respond', `  - AI returned empty for ${original.cpKey}, skipping`)
      continue
    }

    const rfcMessageId = `<${RUN_ID}-r2-${responseIds.length}@e2e-test.local>`
    const references = `${original.rfcMessageId} ${milaReply.messageId}`.trim()

    const rfc2822 = [
      `From: ${original.from}`,
      `To: ${userEmail}`,
      `Subject: Re: ${original.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${rfcMessageId}`,
      `In-Reply-To: ${milaReply.messageId}`,
      `References: ${references}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      responseBody,
    ].join('\r\n')

    const res = await gmail.users.messages.insert({
      userId: 'me',
      requestBody: {
        raw: encodeRaw(rfc2822),
        threadId: milaReply.threadId || original.threadId,
        labelIds: ['INBOX', 'UNREAD'],
      },
      internalDateSource: 'dateHeader',
    })

    const msgId = res.data.id || 'unknown'
    const sameThread = (res.data.threadId || '') === original.threadId
    responseIds.push(msgId)

    log('respond', `  ✓ ${original.cpKey} → ${msgId} (thread: ${sameThread ? '✓ same' : '✗ DIFFERENT'})`)
  }

  log('respond', `Injected ${responseIds.length} tailored CP responses. Waiting 3s...`)
  await new Promise(r => setTimeout(r, 3000))

  return responseIds
}

// ─── Instant notification ────────────────────────────────────────────────────

async function runInstantNotify(): Promise<InstantNotifyResult> {
  log('instant', 'Triggering instant notification poll...')

  const { status, body } = await api(
    'GET',
    '/api/cron/instant-notify',
    { headers: { authorization: `Bearer ${CRON_SECRET}` }, timeout: 60_000 }
  )

  if (status !== 200) {
    fail('instant', `HTTP ${status}: ${JSON.stringify(body)}`)
  }

  const result = body as unknown as InstantNotifyResult
  log('instant', `Result: sent=${result.sent}, failed=${result.failed}`)
  return result
}

// ─── Morning brief ──────────────────────────────────────────────────────────

async function runBrief(userId: string): Promise<void> {
  log('brief', `Triggering morning brief...`)

  const { status, body } = await api(
    'GET',
    `/api/cron/morning-brief?userId=${userId}&type=morning`,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } }
  )

  if (status !== 200) {
    fail('brief', `HTTP ${status}: ${JSON.stringify(body)}`)
  }

  log('brief', `Brief sent successfully`)
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

async function cleanupTestEmails(userId: string, messageIds?: string[]): Promise<number> {
  const gmail = await getGmailClient(userId)
  const deletedIds = new Set<string>()

  if (messageIds?.length) {
    for (const id of messageIds) {
      try {
        await gmail.users.messages.delete({ userId: 'me', id })
        deletedIds.add(id)
      } catch {
        // Message may already be gone
      }
    }
    if (deletedIds.size > 0) {
      log('cleanup', `Permanently deleted ${deletedIds.size} tracked test emails`)
    }
  }

  const cpFromTo = TEST_CP_EMAILS.map(e => `from:${e} to:${e}`).join(' ')
  const searchQueries = [
    `${TEST_MARKER}`,
    `{${cpFromTo}}`,
  ]

  for (const q of searchQueries) {
    log('cleanup', `Searching Gmail with q="${q}" (includeSpamTrash=true)...`)
    let pageToken: string | undefined
    do {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q,
        includeSpamTrash: true,
        maxResults: 500,
        ...(pageToken ? { pageToken } : {}),
      })

      const msgs = list.data.messages || []
      log('cleanup', `  Found ${msgs.length} messages in this page`)

      for (const msg of msgs) {
        if (!msg.id || deletedIds.has(msg.id)) continue
        try {
          await gmail.users.messages.delete({ userId: 'me', id: msg.id })
          deletedIds.add(msg.id)
        } catch {
          // Already deleted or gone
        }
      }

      pageToken = list.data.nextPageToken ?? undefined
    } while (pageToken)
  }

  log('cleanup', `Total: ${deletedIds.size} test emails permanently deleted`)
  return deletedIds.size
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const multiRound = !flags.has('--single-round')

  BASE_URL = await detectBaseUrl()

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mila E2E Pipeline Test — Interactive')
  console.log(`  Mode: ${multiRound ? 'Multi-Round Interactive' : 'Single Round'}`)
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  User:     ${USER_ID}`)
  console.log(`  Target:   ${BASE_URL}`)
  console.log(`  Run ID:   ${RUN_ID}`)
  console.log(`  Flags:    ${[...flags].join(', ') || '(none)'}`)
  console.log('═══════════════════════════════════════════════════════')
  console.log()

  if (!API_KEY) fail('preflight', 'MILA_USER_API_KEY not set in .env.local')
  if (!CRON_SECRET) fail('preflight', 'CRON_SECRET not set in .env.local')
  if (!process.env.NEXTAUTH_SECRET) {
    fail('preflight', 'NEXTAUTH_SECRET not set in .env.local (needed for action tokens)')
  }

  if (flags.has('--cleanup-only')) {
    await cleanupTestEmails(USER_ID)
    log('done', 'Cleanup complete (run scripts/cleanup-test-calendar.ts to clean calendar events)')
    return
  }

  const allGmailIds: string[] = []
  const allChecks: CheckResult[] = []

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // ROUND 1: Inject ALL emails → Run agent → Instant notify
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── Round 1: Inject Emails & Run Agent ────────────────')

    let injected: InjectedEmail[] = []
    if (!flags.has('--skip-inject')) {
      injected = await injectEmails(USER_ID, ALL_TEST_SENDERS)
      allGmailIds.push(...injected.map(e => e.gmailId))
    } else {
      log('inject', 'Skipped (--skip-inject)')
    }

    const r1 = await runAgent(USER_ID, 'R1')

    // Verify Round 1
    log('R1:verify', 'Checking Round 1 results...')
    const r1Checks: CheckResult[] = []

    if (!flags.has('--skip-inject')) {
      r1Checks.push({
        name: 'R1: Emails ingested',
        pass: r1.emailsIngested >= ALL_TEST_SENDERS.length,
        detail: `${r1.emailsIngested} >= ${ALL_TEST_SENDERS.length} expected`,
      })
    }
    r1Checks.push({
      name: 'R1: Messages processed',
      pass: r1.messagesProcessed > 0,
      detail: `${r1.messagesProcessed} messages`,
    })
    r1Checks.push({
      name: 'R1: Conversations created',
      pass: r1.conversationsUpdated > 0,
      detail: `${r1.conversationsUpdated} conversations`,
    })
    r1Checks.push({
      name: 'R1: Actions generated',
      pass: r1.actionsGenerated > 0,
      detail: `${r1.actionsGenerated} actions`,
    })

    // Check for urgent actions
    const highPriority = (r1.actions || []).filter(a => a.urgency >= 9)
    if (!flags.has('--skip-inject')) {
      r1Checks.push({
        name: 'R1: At least one action has urgency >= 9',
        pass: highPriority.length > 0,
        detail: `${highPriority.length} action(s) with urgency >= 9`,
      })
    }

    console.log()
    printChecks(r1Checks)
    allChecks.push(...r1Checks)

    // ═══════════════════════════════════════════════════════════════════════
    // INSTANT NOTIFY
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── Instant Notify ────────────────────────────────────')

    for (const a of highPriority) {
      log('instant', `  ⚡ [${a.action_type}] urgency=${a.urgency} score=${a.priority_score}: ${a.intent_cs || a.rationale}`)
    }

    const notifyResult = await runInstantNotify()

    const instantChecks: CheckResult[] = []
    instantChecks.push({
      name: 'Instant: Endpoint returned success',
      pass: notifyResult.success === true,
      detail: `success=${notifyResult.success}`,
    })
    instantChecks.push({
      name: 'Instant: No failures',
      pass: notifyResult.failed === 0,
      detail: `failed=${notifyResult.failed}`,
    })
    if (highPriority.length > 0) {
      instantChecks.push({
        name: 'Instant: High-priority actions notified',
        pass: notifyResult.sent > 0,
        detail: `sent=${notifyResult.sent} (${highPriority.length} actions had urgency >= 9)`,
      })
    }

    // Idempotency check
    log('instant', 'Re-polling to verify no double-send...')
    const notifyResult2 = await runInstantNotify()
    instantChecks.push({
      name: 'Instant: No double-send on re-poll',
      pass: notifyResult2.sent === 0,
      detail: `sent=${notifyResult2.sent} on re-poll (should be 0)`,
    })

    console.log()
    printChecks(instantChecks)
    allChecks.push(...instantChecks)

    // ═══════════════════════════════════════════════════════════════════════
    // INTERACTIVE PAUSE 1: User interacts with Round 1 actions
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── Your Turn: Interact with Actions ──────────────────')
    printActionUrls(r1.actions || [], USER_ID)

    await waitForKeypress('  ⏎  Press Enter when you\'re done interacting...\n')

    // ═══════════════════════════════════════════════════════════════════════
    // ROUND 2: Scan Mila's replies → tailored CP responses → agent
    // ═══════════════════════════════════════════════════════════════════════
    if (multiRound && injected.length > 0) {
      console.log()
      console.log('─── Round 2: Reading Mila\'s Replies ───────────────────')

      const milaReplies = await scanMilaReplies(USER_ID)

      if (milaReplies.size === 0) {
        log('scan', 'No Mila replies found — skipping CP response round')
      } else {
        console.log()
        console.log('─── Generating Tailored CP Responses ──────────────────')

        const cpResponseIds = await injectTailoredCPResponses(USER_ID, injected, milaReplies)
        allGmailIds.push(...cpResponseIds)

        const r2 = await runAgent(USER_ID, 'R2')

        const r2Checks: CheckResult[] = []
        r2Checks.push({
          name: 'R2: Follow-up emails ingested',
          pass: r2.emailsIngested >= cpResponseIds.length,
          detail: `${r2.emailsIngested} >= ${cpResponseIds.length} expected`,
        })
        r2Checks.push({
          name: 'R2: Messages processed',
          pass: r2.messagesProcessed > 0,
          detail: `${r2.messagesProcessed} messages`,
        })
        r2Checks.push({
          name: 'R2: Conversations updated (threading)',
          pass: r2.conversationsUpdated > 0,
          detail: `${r2.conversationsUpdated} conversations (should reuse existing)`,
        })
        r2Checks.push({
          name: 'R2: New actions generated',
          pass: r2.actionsGenerated > 0,
          detail: `${r2.actionsGenerated} actions from follow-up messages`,
        })

        console.log()
        printChecks(r2Checks)
        allChecks.push(...r2Checks)

        // Interactive pause 2
        if (r2.actions?.length > 0) {
          console.log()
          console.log('─── Your Turn: Round 2 Actions ────────────────────────')
          printActionUrls(r2.actions, USER_ID)
          await waitForKeypress('  ⏎  Press Enter when you\'re done with Round 2...\n')
        }
      }
    } else if (multiRound) {
      log('R2', 'Skipped — no injected emails from Round 1')
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FINAL: Morning brief with full conversation history
    // ═══════════════════════════════════════════════════════════════════════
    if (!flags.has('--skip-brief')) {
      console.log()
      console.log('─── Final: Morning Brief ───────────────────────────────')
      await runBrief(USER_ID)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Cleanup
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    log('cleanup', 'Cleaning up test emails (calendar events preserved for inspection)...')
    await cleanupTestEmails(USER_ID, allGmailIds.length > 0 ? allGmailIds : undefined)

    // ═══════════════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('═══════════════════════════════════════════════════════')

    const passed = allChecks.filter(c => c.pass).length
    const total = allChecks.length
    const allPassed = passed === total

    if (allPassed) {
      console.log(`  RESULT: ALL ${total} CHECKS PASSED`)
    } else {
      console.log(`  RESULT: ${passed}/${total} CHECKS PASSED`)
      console.log()
      console.log('  Failed checks:')
      for (const check of allChecks.filter(c => !c.pass)) {
        console.log(`    ✗ ${check.name}: ${check.detail}`)
      }
    }
    console.log('═══════════════════════════════════════════════════════')

    if (!allPassed) process.exit(1)

  } catch (error) {
    log('cleanup', 'Cleaning up test emails after failure (calendar events preserved)...')
    await cleanupTestEmails(USER_ID, allGmailIds.length > 0 ? allGmailIds : undefined).catch(() => {})
    throw error
  }
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
