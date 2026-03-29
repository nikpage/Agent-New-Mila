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

/**
 * History emails are injected BEFORE the main test emails to give Mila
 * realistic conversation context. They form a thread via In-Reply-To headers.
 * direction: 'inbound' = CP → user, 'outbound' = user → CP
 */
interface HistoryEmail {
  cpKey: string
  direction: 'inbound' | 'outbound'
  from: string
  to: string
  subject: string
  body: string
  /** Days ago this email was "sent" (for realistic Date headers) */
  daysAgo: number
}

// ─── Eva Negotiation History (Thread 1: Lease negotiation) ───────────────────
// Realistic back-and-forth about office space at Sokolovská, Karlín.
// This gives Mila context: the address is Sokolovská 46/51, Praha 8 — NOT
// Eva's signature address (Ďáblická). The negotiation settled at 450 CZK/m2, 3yr.

const EVA_EMAIL = 'ainikpage+dvorakova.eva@gmail.com'
const EVA_FROM = 'Eva Dvorakova <ainikpage+dvorakova.eva@gmail.com>'
// USER_EMAIL is resolved at runtime from Gmail profile

const EVA_NEGOTIATION_SUBJECT = `[${RUN_ID}] Karlin office space — Sokolovská`

const EVA_NEGOTIATION_HISTORY: Omit<HistoryEmail, 'to'>[] = [
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: EVA_NEGOTIATION_SUBJECT,
    daysAgo: 12,
    body: [
      'Dobrý den,',
      '',
      'I found your listing for office space in Karlín on Sokolovská.',
      'We are looking for approx 200m2 for our company Dvorak & Partners s.r.o.',
      '',
      'Could you send us the details — floor plan, price per m2, and available lease terms?',
      '',
      'Děkuji,',
      'Eva Dvořáková',
      'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 9,
    body: [
      'Děkuji za informace o prostorech na Sokolovské 46/51, Praha 8.',
      'Třetí patro, 200m2 open plan se 2 zasedačkami zní dobře.',
      '',
      'Nicméně 465 CZK/m2 je nad náš rozpočet.',
      'Nabízíme 440 CZK/m2/měsíc s desetiletým závazkem.',
      'Delší nájem by měl ospravedlnit nižší sazbu.',
      '',
      'Prostory jsme si prohlédli a vyhovují nám.',
      '',
      'Eva Dvořáková',
      'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 5,
    body: [
      'Dobrý den,',
      '',
      'Děkuji za protinávrh. Projednali jsme s vedením vaši nabídku',
      '450 CZK/m2/měsíc na 3 roky (místo našich původních 440 na 10 let).',
      '',
      'Souhlasíme — 450 CZK/m2/měsíc na 3 roky nám vyhovuje.',
      '',
      'Kdy bychom mohli domluvit podpis smlouvy? Potřebujeme se nastěhovat do poloviny dubna.',
      '',
      'Děkuji,',
      'Eva Dvořáková',
      'Dvorak & Partners s.r.o.',
    ].join('\n'),
  },
]

// ─── Eva Finalization Email (Thread 2: New thread — assumes deal is done) ────
// Separate thread from the negotiation. Eva assumes agreement, wants to
// finalize signing details "around 9 or 10" — this is a loose time hint,
// not a hard constraint. Given the context, Mila should suggest a CALL
// (not face-to-face) to finalize details, scheduled between user's meetings.

const TEST_EMAILS: TestEmail[] = [
  {
    cpKey: 'bob',
    from: 'Bob <ainikpage+Bob@gmail.com>',
    subject: `[${RUN_ID}] Poptávka — byt Vinohradská 45`,
    body: [
      'Dobrý den,',
      '',
      'Viděl jsem vaši nabídku bytu na Vinohradské 45 v Praze. Je ještě k dispozici?',
      'Zvažujeme různé možnosti v příštích měsících a tento byt nás zaujal.',
      '',
      'Můj rozpočet je přibližně 8 500 000 Kč. Je prostor pro vyjednávání?',
      'Žádný spěch — ozvi se, až budeš mít chvíli.',
      '',
      'Díky,',
      'Bob',
    ].join('\n'),
  },
  {
    cpKey: 'eva',
    from: EVA_FROM,
    subject: `[${RUN_ID}] Podpis smlouvy — kancelář Sokolovská`,
    body: [
      'Dobrý den,',
      '',
      'Navazuji na naši dohodu ohledně kanceláře v Karlíně za 450 CZK/m2, 3 roky.',
      'Náš právník zkontroloval návrh smlouvy a jsme připraveni podepsat.',
      '',
      'Můžeme zítra ráno kolem 9 nebo 10 hodin doladit poslední detaily?',
      'Stačil by rychlý telefonát — potřebujeme jen potvrdit finální podmínky',
      'před samotným podpisem.',
      '',
      'Potřebujeme se nastěhovat do dubna, takže čas tlačí.',
      '',
      'Děkuji,',
      'Eva Dvořáková',
      'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  {
    cpKey: 'martin',
    from: 'Martin Kral <ainikpage+kral.martin@gmail.com>',
    subject: `[${RUN_ID}] Změna termínu uzavření — Smíchov`,
    body: [
      'Dobrý den,',
      '',
      'Prodávající nemovitosti na Smíchově chce uzavřít obchod do konce dubna místo května.',
      'Kupní cena 12 400 000 Kč dle dohody.',
      '',
      'Můžete potvrdit, že je financování připraveno? Bankovní dokumenty',
      'bychom měli vyřídit v průběhu příštích dvou týdnů.',
      '',
      'Martin Král',
    ].join('\n'),
  },
]

const HIGH_PRIORITY_EMAIL: TestEmail = {
  cpKey: 'urgent',
  from: 'Jan Novotny <ainikpage+novotny.jan@gmail.com>',
  subject: `[${RUN_ID}] URGENTNÍ: 45M obchod — podpis u notáře zítra ráno`,
  body: [
    'URGENTNÍ — NUTNÁ OKAMŽITÁ ODPOVĚĎ',
    '',
    'Kupující komerční budovy na Vinohradech potvrdil 45 000 000 Kč.',
    'Schůzka u notáře je ZÍTRA v 9:00 na adrese Třinecká 672, Praha.',
    '',
    'Potřebujeme vaše potvrzení DNES do 17:00, jinak obchod padne.',
    'Kupující má další nemovitost v záloze a odejde.',
    '',
    'Potřebné dokumenty:',
    '- Podepsaná kupní smlouva',
    '- Plná moc (originál)',
    '- Doklad o financování z banky',
    '',
    'Toto je největší obchod tohoto čtvrtletí. Prosím, odpovězte IHNED.',
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
    context: 'Lease deal is done: 450 CZK/m2, 3yr, Sokolovská 46/51 Karlín. Need to sign contract and move in by April. You asked for a call "around 9 or 10" to finalize details before signing.',
    guidance: 'If Mila proposed a call time, confirm it. Ask about 3 dedicated parking spots for COO, CFO, and company car. Ask when the actual signing appointment at the office will be.',
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

// ─── Inject history emails (backfill conversation context) ──────────────────

/**
 * Inject a multi-round email thread to give Mila conversation history.
 * Uses In-Reply-To and References headers so Gmail groups them into a thread.
 * Both inbound (CP → user) and outbound (user → CP) messages are injected.
 */
async function injectHistoryThread(
  userId: string,
  historyEmails: Omit<HistoryEmail, 'to'>[],
  label: string
): Promise<string[]> {
  log('history', `Injecting ${historyEmails.length} history emails for "${label}"...`)

  const gmail = await getGmailClient(userId)
  const userEmail = await getUserEmail(userId)
  const gmailIds: string[] = []
  const messageIds: string[] = []
  let threadId: string | undefined

  for (let i = 0; i < historyEmails.length; i++) {
    const email = historyEmails[i]
    const rfcMessageId = `<${RUN_ID}-history-${label}-${i}@e2e-test.local>`
    messageIds.push(rfcMessageId)

    const fromAddr = email.direction === 'outbound' ? userEmail : email.from
    const toAddr = email.direction === 'outbound' ? extractEmail(email.from) : userEmail

    // Backdate the email
    const sendDate = new Date()
    sendDate.setDate(sendDate.getDate() - email.daysAgo)

    const headers: string[] = [
      `From: ${fromAddr}`,
      `To: ${toAddr}`,
      `Subject: ${email.subject}`,
      `Date: ${sendDate.toUTCString()}`,
      `Message-ID: ${rfcMessageId}`,
    ]

    // Threading headers — reference all previous messages in the thread
    if (i > 0) {
      headers.push(`In-Reply-To: ${messageIds[i - 1]}`)
      headers.push(`References: ${messageIds.join(' ')}`)
    }

    headers.push(
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"'
    )

    const rfc2822 = [...headers, '', email.body].join('\r\n')

    // For outbound emails, put them in SENT; for inbound, put in INBOX
    const labelIds = email.direction === 'outbound' ? ['SENT'] : ['INBOX']

    const res = await gmail.users.messages.insert({
      userId: 'me',
      requestBody: {
        raw: encodeRaw(rfc2822),
        labelIds,
        ...(threadId ? { threadId } : {}),
      },
      internalDateSource: 'dateHeader',
    })

    const msgId = res.data.id || 'unknown'
    gmailIds.push(msgId)

    // Capture threadId from first message so subsequent ones join the same thread
    if (!threadId && res.data.threadId) {
      threadId = res.data.threadId
    }

    const arrow = email.direction === 'outbound' ? '→' : '←'
    log('history', `  ${arrow} [${email.daysAgo}d ago] ${email.subject.replace(`[${RUN_ID}] `, '').slice(0, 50)} → ${msgId}`)
  }

  log('history', `Injected ${gmailIds.length} history emails into thread ${threadId || '(new)'}`)
  return gmailIds
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
    // ROUND 1: Inject each email independently → agent → instant-notify
    //
    // In production, emails arrive at different times. Each triggers its own
    // cron cycle: agent ingests → proposes actions → instant-notify schedules.
    // A SCHEDULE hold created for email #1 is a real GCal event by the time
    // email #2 arrives. There is NO batch optimization across independent emails.
    // The script mirrors this: inject one, process it fully, then the next.
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── Round 1: Independent Email Processing ─────────────')

    let injected: InjectedEmail[] = []
    // Collect all actions across independent email runs for later interaction
    let allR1Actions: ActionProposal[] = []
    let allR1Results: AgentResult[] = []

    if (!flags.has('--skip-inject')) {
      // ── Phase 0: Inject conversation history (backfill) ──────────────
      // Eva's negotiation thread gives Mila context about the Sokolovská
      // address and the agreed 450 CZK/m2 terms — before the "current" email arrives.
      console.log()
      console.log('─── Phase 0: Injecting Conversation History ────────────')

      const evaHistoryIds = await injectHistoryThread(
        USER_ID,
        EVA_NEGOTIATION_HISTORY,
        'eva-negotiation'
      )
      allGmailIds.push(...evaHistoryIds)

      // Run bulk ingestion to process history — ingest, enrich, thread, summarize.
      // NO action generation — history is context only, not new work.
      log('history', 'Running bulk ingestion to process history emails...')
      const sinceDate = new Date()
      sinceDate.setDate(sinceDate.getDate() - 14) // cover all history emails
      const bulkRes = await fetch(`${BASE_URL}/api/ingest/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ userId: USER_ID, since: sinceDate.toISOString(), maxTotal: 50 }),
        signal: AbortSignal.timeout(300_000),
      })
      const bulkText = await bulkRes.text()
      const bulkLines = bulkText.trim().split('\n').filter(Boolean)
      for (const line of bulkLines.slice(-3)) {
        log('history', `  ${line.trim()}`)
      }
      log('history', 'History processed via bulk ingestion (no actions generated)')

      // Brief pause for Gmail indexing before Round 1 emails
      await new Promise(r => setTimeout(r, 2000))

      // ── Phase 1: Process each email independently ──────────────────
      // Each email gets: inject → wait for Gmail → agent run → instant-notify.
      // This mirrors production where each email lands in a separate cron cycle.
      // SCHEDULE holds from earlier emails become real GCal events before
      // the next email is processed — no batch optimization, no shared state.
      console.log()
      console.log('─── Phase 1: Independent Email Processing ─────────────')

      for (let i = 0; i < ALL_TEST_SENDERS.length; i++) {
        const email = ALL_TEST_SENDERS[i]
        const emailLabel = `E${i + 1}/${ALL_TEST_SENDERS.length}`

        console.log()
        log(emailLabel, `── Processing: "${email.subject.replace(`[${RUN_ID}] `, '')}" ──`)

        // Inject single email
        const [injectedEmail] = await injectEmails(USER_ID, [email])
        injected.push(injectedEmail)
        allGmailIds.push(injectedEmail.gmailId)

        // Run agent — ingests this email, creates conversation + action
        const agentResult = await runAgent(USER_ID, emailLabel)
        allR1Results.push(agentResult)
        if (agentResult.actions?.length) {
          allR1Actions.push(...agentResult.actions)
        }

        // Instant-notify — if this email produced urgent actions, schedule + send NOW.
        // Any SCHEDULE holds are written to GCal before the next email is processed.
        const urgentActions = (agentResult.actions || []).filter(a => a.urgency >= 9)
        if (urgentActions.length > 0) {
          for (const a of urgentActions) {
            log(emailLabel, `  ⚡ [${a.action_type}] urgency=${a.urgency} score=${a.priority_score}: ${a.intent_cs || a.rationale}`)
          }
          const notifyRes = await runInstantNotify()
          log(emailLabel, `  Instant-notify: sent=${notifyRes.sent}, failed=${notifyRes.failed}`)
        }

        // Brief pause for Gmail indexing between emails
        if (i < ALL_TEST_SENDERS.length - 1) {
          await new Promise(r => setTimeout(r, 2000))
        }
      }
    } else {
      log('inject', 'Skipped (--skip-inject)')
      // Still need one agent run to pick up any existing unprocessed emails
      const r1 = await runAgent(USER_ID, 'R1')
      allR1Results.push(r1)
      if (r1.actions?.length) {
        allR1Actions.push(...r1.actions)
      }
    }

    // Aggregate totals across all independent runs
    const totalIngested = allR1Results.reduce((sum, r) => sum + r.emailsIngested, 0)
    const totalProcessed = allR1Results.reduce((sum, r) => sum + r.messagesProcessed, 0)
    const totalConversations = allR1Results.reduce((sum, r) => sum + r.conversationsUpdated, 0)
    const totalActions = allR1Results.reduce((sum, r) => sum + r.actionsGenerated, 0)

    // Verify Round 1
    log('R1:verify', 'Checking Round 1 aggregate results...')
    const r1Checks: CheckResult[] = []

    if (!flags.has('--skip-inject')) {
      r1Checks.push({
        name: 'R1: Emails ingested (total)',
        pass: totalIngested >= ALL_TEST_SENDERS.length,
        detail: `${totalIngested} >= ${ALL_TEST_SENDERS.length} expected`,
      })
    }
    r1Checks.push({
      name: 'R1: Messages processed (total)',
      pass: totalProcessed > 0,
      detail: `${totalProcessed} messages`,
    })
    r1Checks.push({
      name: 'R1: Conversations created (total)',
      pass: totalConversations > 0,
      detail: `${totalConversations} conversations`,
    })
    r1Checks.push({
      name: 'R1: Actions generated (total)',
      pass: totalActions > 0,
      detail: `${totalActions} actions`,
    })

    // Check for urgent actions
    const highPriority = allR1Actions.filter(a => a.urgency >= 9)
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
    // INSTANT NOTIFY — final idempotency check
    // All urgent actions were already notified during per-email processing.
    // This verifies no double-send occurs on a subsequent poll.
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── Instant Notify — Idempotency Check ────────────────')

    const notifyResult2 = await runInstantNotify()

    const instantChecks: CheckResult[] = []
    instantChecks.push({
      name: 'Instant: No double-send on final poll',
      pass: notifyResult2.sent === 0,
      detail: `sent=${notifyResult2.sent} on final poll (should be 0 — all already sent)`,
    })

    console.log()
    printChecks(instantChecks)
    allChecks.push(...instantChecks)

    // ═══════════════════════════════════════════════════════════════════════
    // INTERACTIVE PAUSE 1: User interacts with Round 1 actions
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── Your Turn: Interact with Actions ──────────────────')
    printActionUrls(allR1Actions, USER_ID)

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
