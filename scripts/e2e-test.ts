#!/usr/bin/env npx tsx
/**
 * E2E Pipeline Test — Standalone
 *
 * Injects test emails into a Mila user's Gmail inbox (appearing from
 * simulated counterparties), then runs the full agent pipeline and
 * verifies ingestion → enrichment → threading → action proposals → brief.
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts [userId]
 *
 * Default userId: d1a403fd-121b-4dcc-96aa-0efa3af114a8 (podtwo@gmail.com)
 *
 * Reads MILA_USER_API_KEY, CRON_SECRET, etc. from .env.local
 *
 * Flags:
 *   --skip-inject     Skip email injection (re-run agent on existing mail)
 *   --skip-brief      Skip morning brief step
 *   --cleanup-only    Delete previously injected test emails and exit
 *   --prod            Use production URL (https://mila.specialagents.pro)
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { google } from 'googleapis'
import { getAuthenticatedClient } from '../src/lib/google/auth'

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
  from: string
  subject: string
  body: string
}

const TEST_EMAILS: TestEmail[] = [
  {
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
  const timer = setTimeout(() => controller.abort(), options.timeout || 300_000) // 5 min default
  init.signal = controller.signal

  const res = await fetch(url, init)
  clearTimeout(timer)

  const ct = res.headers.get('content-type') || ''
  const body = ct.includes('json') ? await res.json() : { text: await res.text() }
  return { status: res.status, body: body as Record<string, unknown> }
}

async function getGmailClient(userId: string) {
  const auth = await getAuthenticatedClient(userId)
  return google.gmail({ version: 'v1', auth })
}

// ─── Step 1: Inject test emails ──────────────────────────────────────────────

async function injectTestEmails(userId: string): Promise<string[]> {
  log('inject', `Injecting ${TEST_EMAILS.length} test emails into inbox...`)

  const gmail = await getGmailClient(userId)

  // Fetch user's actual email for the To: header
  const profile = await gmail.users.getProfile({ userId: 'me' })
  const userEmail = profile.data.emailAddress || 'test@example.com'

  const injectedIds: string[] = []

  for (const email of TEST_EMAILS) {
    const rfc2822 = [
      `From: ${email.from}`,
      `To: ${userEmail}`,
      `Subject: ${email.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${RUN_ID}-${injectedIds.length}@e2e-test.local>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      email.body,
    ].join('\r\n')

    const raw = Buffer.from(rfc2822)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    // Use insert (not import) so we control labels directly.
    // import() runs SMTP-like classification (spam, Promotions, etc.)
    // which often strips INBOX/UNREAD from test emails, causing the
    // agent's fetchUnreadEmails() to miss them.
    const res = await gmail.users.messages.insert({
      userId: 'me',
      requestBody: { raw, labelIds: ['INBOX', 'UNREAD'] },
      internalDateSource: 'dateHeader',
    })

    const msgId = res.data.id || 'unknown'
    injectedIds.push(msgId)
    log('inject', `  ✓ "${email.subject.replace(`[${RUN_ID}] `, '')}" → ${msgId}`)
  }

  log('inject', `Injected ${injectedIds.length} emails. Waiting 3s for Gmail indexing...`)
  await new Promise(r => setTimeout(r, 3000))

  return injectedIds
}

// ─── Step 2: Run agent pipeline ──────────────────────────────────────────────

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
  errors: string[]
}

async function runAgent(userId: string): Promise<AgentResult> {
  log('agent', `Triggering agent run at ${BASE_URL}...`)

  const { status, body } = await api('POST', '/api/agent/run', {
    headers: { 'x-api-key': API_KEY },
    body: { userId },
    timeout: 300_000, // 5 min — agent pipeline can be slow
  })

  if (status !== 200) {
    fail('agent', `HTTP ${status}: ${JSON.stringify(body)}`)
  }

  const result = body as unknown as AgentResult
  if (!result.success) {
    fail('agent', `Agent returned success=false: ${JSON.stringify(result.errors)}`)
  }

  log('agent', `Results:`)
  log('agent', `  Emails ingested:      ${result.emailsIngested}`)
  log('agent', `  Calendar synced:      ${result.calendarEventsSynced}`)
  log('agent', `  Messages processed:   ${result.messagesProcessed}`)
  log('agent', `  Conversations updated: ${result.conversationsUpdated}`)
  log('agent', `  Actions generated:    ${result.actionsGenerated}`)
  log('agent', `  Follow-ups generated: ${result.followUpsGenerated}`)
  log('agent', `  Cooling leads:        ${result.coolingLeads}`)
  log('agent', `  Cold leads:           ${result.coldLeads}`)

  if (result.errors?.length) {
    log('agent', `  Errors: ${result.errors.join(', ')}`)
  }

  return result
}

// ─── Step 3: Run morning brief ───────────────────────────────────────────────

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

// ─── Step 4: Cleanup injected emails ─────────────────────────────────────────

async function cleanupTestEmails(userId: string, messageIds?: string[]): Promise<number> {
  const gmail = await getGmailClient(userId)
  let deleted = 0

  if (messageIds?.length) {
    // Delete specific injected messages
    for (const id of messageIds) {
      try {
        await gmail.users.messages.trash({ userId: 'me', id })
        deleted++
      } catch {
        // Message may already be gone
      }
    }
  } else {
    // Search for all test emails by marker
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
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mila E2E Pipeline Test')
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

  // Cleanup-only mode
  if (flags.has('--cleanup-only')) {
    await cleanupTestEmails(USER_ID)
    log('done', 'Cleanup complete')
    return
  }

  let injectedIds: string[] = []

  try {
    // Step 1: Inject test emails
    if (!flags.has('--skip-inject')) {
      injectedIds = await injectTestEmails(USER_ID)
    } else {
      log('inject', 'Skipped (--skip-inject)')
    }

    // Step 2: Run agent pipeline
    const result = await runAgent(USER_ID)

    // Step 3: Validate results
    log('verify', 'Checking pipeline results...')

    const checks: { name: string; pass: boolean; detail: string }[] = []

    if (!flags.has('--skip-inject')) {
      checks.push({
        name: 'Emails ingested',
        pass: result.emailsIngested >= TEST_EMAILS.length,
        detail: `${result.emailsIngested} >= ${TEST_EMAILS.length} expected`,
      })
    }

    checks.push({
      name: 'Messages processed',
      pass: result.messagesProcessed > 0,
      detail: `${result.messagesProcessed} messages`,
    })

    checks.push({
      name: 'Conversations created/updated',
      pass: result.conversationsUpdated > 0,
      detail: `${result.conversationsUpdated} conversations`,
    })

    checks.push({
      name: 'Actions generated',
      pass: result.actionsGenerated > 0,
      detail: `${result.actionsGenerated} actions`,
    })

    console.log()
    let allPassed = true
    for (const check of checks) {
      const icon = check.pass ? '✓' : '✗'
      log('verify', `  ${icon} ${check.name}: ${check.detail}`)
      if (!check.pass) allPassed = false
    }
    console.log()

    // Step 4: Morning brief
    if (!flags.has('--skip-brief')) {
      await runBrief(USER_ID)
    } else {
      log('brief', 'Skipped (--skip-brief)')
    }

    // Step 5: Cleanup
    if (injectedIds.length > 0) {
      log('cleanup', 'Cleaning up injected test emails...')
      await cleanupTestEmails(USER_ID, injectedIds)
    }

    // Summary
    console.log()
    console.log('═══════════════════════════════════════════════════════')
    if (allPassed) {
      console.log('  RESULT: ALL CHECKS PASSED')
    } else {
      console.log('  RESULT: SOME CHECKS FAILED')
    }
    console.log('═══════════════════════════════════════════════════════')

    if (!allPassed) process.exit(1)
  } catch (error) {
    // Attempt cleanup even on failure
    if (injectedIds.length > 0) {
      log('cleanup', 'Cleaning up after failure...')
      await cleanupTestEmails(USER_ID, injectedIds).catch(() => {})
    }
    throw error
  }
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
