#!/usr/bin/env npx tsx
/**
 * E2E Pipeline Test — Multi-Round Conversation
 *
 * Simulates a full email lifecycle:
 *   Round 1: CPs email the user → agent ingests → generates REPLY actions
 *   Round 2: Execute REPLY actions (Mila sends emails) → verify execution
 *   Round 3: CPs respond back in same threads → agent re-runs → verifies
 *            threading into existing conversations + new action proposals
 *   Final:  Morning brief with full conversation history
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts [userId]
 *
 * Default userId: 9e59bc06-7276-453d-bc2e-f224a0a327e3
 *
 * Reads MILA_USER_API_KEY, CRON_SECRET, NEXTAUTH_SECRET from .env.local
 *
 * Flags:
 *   --skip-inject     Skip email injection (re-run agent on existing mail)
 *   --skip-brief      Skip morning brief step
 *   --single-round    Only run Round 1 (inject + agent), skip conversation
 *   --cleanup-only    Delete previously injected test emails and exit
 *   --prod            Use production URL (https://mila.specialagents.pro)
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { google, gmail_v1 } from 'googleapis'
import { getAuthenticatedClient } from '../src/lib/google/auth'
import { generateActionToken } from '../src/lib/auth/tokens'

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const positional = args.filter(a => !a.startsWith('--'))

const USER_ID = positional[0] || '9e59bc06-7276-453d-bc2e-f224a0a327e3'
const BASE_URL = flags.has('--prod')
  ? 'https://mila.specialagents.pro'
  : (process.env.E2E_BASE_URL || process.env.APP_BASE_URL || 'http://localhost:3000')
const API_KEY = process.env.MILA_USER_API_KEY || ''
const CRON_SECRET = process.env.CRON_SECRET || ''

// Unique marker so we can find/clean up our test emails
const TEST_MARKER = 'E2E-TEST'
const RUN_ID = `${TEST_MARKER}-${Date.now()}`

// ─── Test Scenarios ──────────────────────────────────────────────────────────
// Each simulates a different counterparty emailing the Mila user.

interface TestEmail {
  /** Key to match with CP follow-up responses */
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
      'I saw your listing for the apartment on Vinohradska 45. Is it still available?',
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
      'Can we finalize the contract this week? We need to move in by April.',
      '',
      'Dekuji,',
      'Eva Dvorakova',
      'Dvorak & Partners s.r.o.',
    ].join('\n'),
  },
  {
    cpKey: 'martin',
    from: 'Martin Kral <ainikpage+kral.martin@gmail.com>',
    subject: `[${RUN_ID}] Urgent: Closing date moved up`,
    body: [
      'Hi,',
      '',
      'The seller of the Smichov property wants to close by March 15 instead of March 31.',
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

/** CP follow-up responses for Round 3 — keyed by cpKey */
const CP_RESPONSES: Record<string, string> = {
  bob: [
    'Great, thank you for your quick response!',
    '',
    'Tuesday at 2pm works perfectly for the viewing.',
    'Can I bring my wife along? She wants to see the kitchen and bathrooms.',
    '',
    'Also, is parking included or is that extra?',
    '',
    'Bob',
  ].join('\n'),

  eva: [
    'Dobry den,',
    '',
    'Thank you for the update. 450 CZK/m2 is our final offer.',
    'We can meet at your office on Thursday to sign the lease.',
    '',
    'One more thing — we need 3 dedicated parking spots in the building.',
    'Is that possible? Our COO, CFO and a company car need spaces.',
    '',
    'S pozdravem,',
    'Eva Dvorakova',
  ].join('\n'),

  martin: [
    'Hi,',
    '',
    'Good news — the bank confirmed the financing today.',
    'All documents are signed and ready to go.',
    '',
    'When can we meet at the notary? The seller prefers morning hours.',
    'I am available Monday through Wednesday next week.',
    '',
    'Martin',
  ].join('\n'),
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

// ─── Round 1: Inject initial CP emails ──────────────────────────────────────

async function injectTestEmails(userId: string): Promise<InjectedEmail[]> {
  log('R1:inject', `Injecting ${TEST_EMAILS.length} test emails into inbox...`)

  const gmail = await getGmailClient(userId)
  const userEmail = await getUserEmail(userId)
  const injected: InjectedEmail[] = []

  for (const email of TEST_EMAILS) {
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

    // Use insert (not import) so we control labels directly.
    // import() runs SMTP-like classification which strips INBOX/UNREAD.
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
    log('R1:inject', `  ✓ "${email.subject.replace(`[${RUN_ID}] `, '')}" → ${res.data.id} (thread: ${res.data.threadId})`)
  }

  log('R1:inject', `Injected ${injected.length} emails. Waiting 3s for Gmail indexing...`)
  await new Promise(r => setTimeout(r, 3000))

  return injected
}

// ─── Run agent pipeline (reusable) ──────────────────────────────────────────

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
      log(`${roundLabel}:agent`, `    - [${a.action_type}] ${a.intent_cs || a.rationale} (score: ${a.priority_score})`)
    }
  }
  if (result.errors?.length) {
    log(`${roundLabel}:agent`, `  Errors: ${result.errors.join(', ')}`)
  }

  return result
}

// ─── Round 2: Execute REPLY actions ─────────────────────────────────────────

interface ExecutedAction {
  actionId: string
  cpKey: string | null
  success: boolean
}

async function executeReplyActions(
  userId: string,
  actions: ActionProposal[],
  injected: InjectedEmail[]
): Promise<ExecutedAction[]> {
  const replyActions = actions.filter(a => a.action_type === 'REPLY' && a.status === 'pending')
  log('R2:execute', `Found ${replyActions.length} REPLY actions to execute out of ${actions.length} total`)

  if (replyActions.length === 0) {
    log('R2:execute', 'No REPLY actions to execute — skipping Round 2')
    return []
  }

  const executed: ExecutedAction[] = []

  for (const action of replyActions) {
    // Match action to CP via conversation → try to find the cpKey
    const matchedEmail = injected.find(e => {
      // Match by CP identifier in the from field
      const fromEmail = e.from.match(/<([^>]+)>/)?.[1] || e.from
      return action.payload?.channel === 'email/gmail' || true // best-effort match
    })

    const token = generateActionToken(action.id, userId)

    log('R2:execute', `  Executing action ${action.id} [${action.action_type}]...`)
    const { status, body } = await api('POST', `/api/action/${action.id}/execute`, {
      body: { token },
      timeout: 60_000,
    })

    const success = status === 200
    if (success) {
      log('R2:execute', `    ✓ ${(body as Record<string, unknown>).message || 'Done'}`)
    } else {
      log('R2:execute', `    ✗ HTTP ${status}: ${JSON.stringify(body)}`)
    }

    executed.push({
      actionId: action.id,
      cpKey: matchedEmail?.cpKey || null,
      success,
    })
  }

  // Wait for Gmail to process the sent emails
  log('R2:execute', `Executed ${executed.filter(e => e.success).length}/${replyActions.length} actions. Waiting 3s...`)
  await new Promise(r => setTimeout(r, 3000))

  return executed
}

// ─── Round 3: Inject CP follow-up responses ─────────────────────────────────

async function injectCPResponses(
  userId: string,
  injected: InjectedEmail[]
): Promise<string[]> {
  log('R3:respond', 'Injecting CP follow-up responses into existing threads...')

  const gmail = await getGmailClient(userId)
  const userEmail = await getUserEmail(userId)
  const responseIds: string[] = []

  for (const original of injected) {
    const responseBody = CP_RESPONSES[original.cpKey]
    if (!responseBody) {
      log('R3:respond', `  - No follow-up defined for cpKey="${original.cpKey}", skipping`)
      continue
    }

    const rfcMessageId = `<${RUN_ID}-reply-${responseIds.length}@e2e-test.local>`
    const rfc2822 = [
      `From: ${original.from}`,
      `To: ${userEmail}`,
      `Subject: Re: ${original.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${rfcMessageId}`,
      `In-Reply-To: ${original.rfcMessageId}`,
      `References: ${original.rfcMessageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      responseBody,
    ].join('\r\n')

    const res = await gmail.users.messages.insert({
      userId: 'me',
      requestBody: {
        raw: encodeRaw(rfc2822),
        threadId: original.threadId,
        labelIds: ['INBOX', 'UNREAD'],
      },
      internalDateSource: 'dateHeader',
    })

    const msgId = res.data.id || 'unknown'
    const msgThread = res.data.threadId || 'unknown'
    responseIds.push(msgId)

    const sameThread = msgThread === original.threadId
    log('R3:respond', `  ✓ ${original.cpKey} response → ${msgId} (thread: ${msgThread}${sameThread ? ' ✓ same' : ' ✗ DIFFERENT!'})`)
  }

  log('R3:respond', `Injected ${responseIds.length} CP responses. Waiting 3s for Gmail indexing...`)
  await new Promise(r => setTimeout(r, 3000))

  return responseIds
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
  let deleted = 0

  if (messageIds?.length) {
    for (const id of messageIds) {
      try {
        await gmail.users.messages.trash({ userId: 'me', id })
        deleted++
      } catch {
        // Message may already be gone
      }
    }
  } else {
    log('cleanup', `Searching for emails with marker "${TEST_MARKER}"...`)
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `subject:${TEST_MARKER}`,
      maxResults: 100,
    })

    for (const msg of list.data.messages || []) {
      if (!msg.id) continue
      try {
        await gmail.users.messages.trash({ userId: 'me', id: msg.id })
        deleted++
      } catch {
        // ignore
      }
    }
  }

  log('cleanup', `Trashed ${deleted} test emails`)
  return deleted
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const multiRound = !flags.has('--single-round')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mila E2E Pipeline Test')
  console.log(`  Mode: ${multiRound ? 'Multi-Round Conversation' : 'Single Round'}`)
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  User:     ${USER_ID}`)
  console.log(`  Target:   ${BASE_URL}`)
  console.log(`  Run ID:   ${RUN_ID}`)
  console.log(`  Flags:    ${[...flags].join(', ') || '(none)'}`)
  console.log('═══════════════════════════════════════════════════════')
  console.log()

  // Preflight checks
  if (!API_KEY) fail('preflight', 'MILA_USER_API_KEY not set in .env.local')
  if (!CRON_SECRET) fail('preflight', 'CRON_SECRET not set in .env.local')
  if (multiRound && !process.env.NEXTAUTH_SECRET) {
    fail('preflight', 'NEXTAUTH_SECRET not set in .env.local (needed for action tokens)')
  }

  // Cleanup-only mode
  if (flags.has('--cleanup-only')) {
    await cleanupTestEmails(USER_ID)
    log('done', 'Cleanup complete')
    return
  }

  // Track all Gmail message IDs for cleanup
  const allGmailIds: string[] = []
  const allChecks: CheckResult[] = []

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // ROUND 1: Inject CP emails → Run agent → Verify ingestion + actions
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── Round 1: Initial CP Emails ────────────────────────')

    let injected: InjectedEmail[] = []
    if (!flags.has('--skip-inject')) {
      injected = await injectTestEmails(USER_ID)
      allGmailIds.push(...injected.map(e => e.gmailId))
    } else {
      log('R1:inject', 'Skipped (--skip-inject)')
    }

    const r1 = await runAgent(USER_ID, 'R1')

    // Verify Round 1
    log('R1:verify', 'Checking Round 1 results...')
    const r1Checks: CheckResult[] = []

    if (!flags.has('--skip-inject')) {
      r1Checks.push({
        name: 'R1: Emails ingested',
        pass: r1.emailsIngested >= TEST_EMAILS.length,
        detail: `${r1.emailsIngested} >= ${TEST_EMAILS.length} expected`,
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

    console.log()
    printChecks(r1Checks)
    allChecks.push(...r1Checks)

    // ═══════════════════════════════════════════════════════════════════════
    // ROUND 2: Execute REPLY actions (Mila sends emails back to CPs)
    // ═══════════════════════════════════════════════════════════════════════
    if (multiRound && r1.actions?.length > 0 && injected.length > 0) {
      console.log()
      console.log('─── Round 2: Execute Actions (Mila Replies) ───────────')

      const executed = await executeReplyActions(USER_ID, r1.actions, injected)

      const r2Checks: CheckResult[] = []
      const successCount = executed.filter(e => e.success).length
      r2Checks.push({
        name: 'R2: Actions executed',
        pass: successCount > 0,
        detail: `${successCount}/${executed.length} succeeded`,
      })

      console.log()
      printChecks(r2Checks)
      allChecks.push(...r2Checks)

      // ═══════════════════════════════════════════════════════════════════
      // ROUND 3: CPs respond back → Run agent → Verify threading
      // ═══════════════════════════════════════════════════════════════════
      console.log()
      console.log('─── Round 3: CP Follow-Up Responses ────────────────────')

      const responseIds = await injectCPResponses(USER_ID, injected)
      allGmailIds.push(...responseIds)

      const r3 = await runAgent(USER_ID, 'R3')

      log('R3:verify', 'Checking Round 3 results...')
      const r3Checks: CheckResult[] = []

      r3Checks.push({
        name: 'R3: Follow-up emails ingested',
        pass: r3.emailsIngested >= responseIds.length,
        detail: `${r3.emailsIngested} >= ${responseIds.length} expected`,
      })
      r3Checks.push({
        name: 'R3: Messages processed',
        pass: r3.messagesProcessed > 0,
        detail: `${r3.messagesProcessed} messages`,
      })
      r3Checks.push({
        name: 'R3: Conversations updated (threading)',
        pass: r3.conversationsUpdated > 0,
        detail: `${r3.conversationsUpdated} conversations (should reuse existing)`,
      })
      r3Checks.push({
        name: 'R3: New actions generated',
        pass: r3.actionsGenerated > 0,
        detail: `${r3.actionsGenerated} actions from follow-up messages`,
      })

      console.log()
      printChecks(r3Checks)
      allChecks.push(...r3Checks)

    } else if (multiRound) {
      log('R2', 'Skipped — no REPLY actions or no injected emails from Round 1')
      log('R3', 'Skipped — depends on Round 2')
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
    if (allGmailIds.length > 0) {
      console.log()
      log('cleanup', `Cleaning up ${allGmailIds.length} injected test emails...`)
      await cleanupTestEmails(USER_ID, allGmailIds)
    }

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
    // Attempt cleanup even on failure
    if (allGmailIds.length > 0) {
      log('cleanup', 'Cleaning up after failure...')
      await cleanupTestEmails(USER_ID, allGmailIds).catch(() => {})
    }
    throw error
  }
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
