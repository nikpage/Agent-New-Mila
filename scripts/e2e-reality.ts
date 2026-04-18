#!/usr/bin/env npx tsx
/**
 * E2E Reality — Production-realism test.
 *
 * Mirrors prod dispatcher behavior: each current email arrives separately, is
 * fully processed (agent run completes), and only then does the next email
 * arrive. Catches bugs where card/placeholder generation depends on the
 * world-model state at the moment a specific email arrived — bugs that
 * batch-mode tests (e2e-pipeline.ts) cannot surface.
 *
 * Phase 0 mirrors pipeline: history threads bulk-ingested as backdrop, plus
 * the self-email command to create the Petr Svoboda CP.
 *
 * Phase 1 is serial: for each REALITY_EMAIL, inject → agent run → snapshot →
 * dispatch cpKey-specific assertions against the known brief bugs.
 *
 * Full AI by default — no cassette. Long runtime expected (~20 min).
 *
 * Usage: npx tsx scripts/e2e-reality.ts [userId]
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { google, gmail_v1 } from 'googleapis'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getAuthenticatedClient } from '../src/lib/google/auth'
import {
  ALL_HISTORY_THREADS,
  SELF_EMAIL_COMMAND,
  REALITY_EMAILS,
  type RealityEmail,
} from './e2e-reality-fixtures'
import type { FixtureHistoryEmail } from './e2e-fixtures'

// ─── Config ──────────────────────────────────────────────────────────────────

const USER_ID = process.argv[2] || '9e59bc06-7276-453d-bc2e-f224a0a327e3'
const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.APP_BASE_URL ||
  'http://localhost:3000'
const API_KEY = process.env.MILA_USER_API_KEY || ''
const CRON_SECRET = process.env.CRON_SECRET || ''
const RUN_ID = `E2E-REALITY-${Date.now()}`

if (!API_KEY) { console.error('MILA_USER_API_KEY not set'); process.exit(1) }
if (!CRON_SECRET) { console.error('CRON_SECRET not set'); process.exit(1) }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); process.exit(1)
}

const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
)

// ─── Gmail plumbing ──────────────────────────────────────────────────────────

let _gmail: gmail_v1.Gmail | null = null
let _userEmail = ''

async function gmailClient(): Promise<gmail_v1.Gmail> {
  if (_gmail) return _gmail
  const auth = await getAuthenticatedClient(USER_ID)
  _gmail = google.gmail({ version: 'v1', auth })
  return _gmail
}

async function userEmail(): Promise<string> {
  if (_userEmail) return _userEmail
  const gmail = await gmailClient()
  const prof = await gmail.users.getProfile({ userId: 'me' })
  _userEmail = prof.data.emailAddress || ''
  return _userEmail
}

function encodeRaw(rfc2822: string): string {
  return Buffer.from(rfc2822)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function extractAddr(from: string): string {
  const m = from.match(/<([^>]+)>/); return m ? m[1] : from
}

// ─── Phase 0: history + self-email injection ─────────────────────────────────

async function injectHistoryThread(
  emails: FixtureHistoryEmail[],
  label: string,
): Promise<void> {
  const gmail = await gmailClient()
  const me = await userEmail()
  const msgIds: string[] = []
  let threadId: string | undefined

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i]
    const rfcId = `<${RUN_ID}-hist-${label}-${i}@e2e-reality.local>`
    msgIds.push(rfcId)

    const fromAddr = e.direction === 'outbound' ? me : e.from
    const toAddr = e.direction === 'outbound' ? extractAddr(e.from) : me
    const date = new Date(); date.setDate(date.getDate() - e.daysAgo)

    const headers = [
      `From: ${fromAddr}`,
      `To: ${toAddr}`,
      `Subject: [${RUN_ID}] ${e.subjectSuffix}`,
      `Date: ${date.toUTCString()}`,
      `Message-ID: ${rfcId}`,
    ]
    if (i > 0) {
      headers.push(`In-Reply-To: ${msgIds[i - 1]}`)
      headers.push(`References: ${msgIds.join(' ')}`)
    }
    headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"')

    const rfc2822 = [...headers, '', e.body].join('\r\n')
    const res = await gmail.users.messages.insert({
      userId: 'me',
      requestBody: {
        raw: encodeRaw(rfc2822),
        labelIds: e.direction === 'outbound' ? ['SENT'] : ['INBOX'],
        ...(threadId ? { threadId } : {}),
      },
      internalDateSource: 'dateHeader',
    })
    if (!threadId && res.data.threadId) threadId = res.data.threadId
  }
  console.log(`  [history] ${label}: ${emails.length} msgs → thread ${threadId}`)
}

async function injectSelfEmail(): Promise<void> {
  const gmail = await gmailClient()
  const me = await userEmail()
  const rfcId = `<${RUN_ID}-self@e2e-reality.local>`
  const rfc2822 = [
    `From: ${me}`,
    `To: ${me}`,
    `Subject: [${RUN_ID}] ${SELF_EMAIL_COMMAND.subjectSuffix}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${rfcId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    SELF_EMAIL_COMMAND.body,
  ].join('\r\n')
  await gmail.users.messages.insert({
    userId: 'me',
    requestBody: { raw: encodeRaw(rfc2822), labelIds: ['INBOX', 'UNREAD'] },
    internalDateSource: 'dateHeader',
  })
  console.log(`  [self] ${SELF_EMAIL_COMMAND.subjectSuffix}`)
}

async function bulkIngest(): Promise<void> {
  const since = new Date(); since.setDate(since.getDate() - 40)
  const res = await fetch(`${BASE_URL}/api/ingest/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ userId: USER_ID, since: since.toISOString(), maxTotal: 100 }),
    signal: AbortSignal.timeout(600_000),
  })
  if (!res.ok) throw new Error(`bulk ingest failed: HTTP ${res.status}`)
  const reader = res.body?.getReader()
  if (reader) { while (!(await reader.read()).done) {} }
  console.log(`  [bulk] history ingested`)
}

// ─── Per-email injection (serial, one-at-a-time like prod dispatcher) ────────

async function injectEmail(e: RealityEmail, index: number): Promise<void> {
  const gmail = await gmailClient()
  const me = await userEmail()
  const rfcId = `<${RUN_ID}-${index}-${e.cpKey}@e2e-reality.local>`

  const rfc2822 = [
    `From: ${e.from}`,
    `To: ${me}`,
    `Subject: [${RUN_ID}] ${e.subjectSuffix}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${rfcId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    e.body,
  ].join('\r\n')

  await gmail.users.messages.insert({
    userId: 'me',
    requestBody: { raw: encodeRaw(rfc2822), labelIds: ['INBOX', 'UNREAD'] },
    internalDateSource: 'dateHeader',
  })
}

// ─── Agent run ───────────────────────────────────────────────────────────────

interface AgentResult {
  success: boolean
  emailsIngested: number
  actionsGenerated: number
  errors: string[]
}

async function runAgent(): Promise<AgentResult> {
  const res = await fetch(`${BASE_URL}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ userId: USER_ID }),
    signal: AbortSignal.timeout(600_000),
  })
  if (!res.ok) throw new Error(`agent run failed: HTTP ${res.status}`)
  return (await res.json()) as AgentResult
}

// ─── State snapshot ──────────────────────────────────────────────────────────

type Row = Record<string, unknown>

interface Snapshot {
  cps: Row[]
  actions: Row[]            // pending action_proposals only
  dealParticipants: Row[]
  calendarEvents: Row[]
}

async function captureState(): Promise<Snapshot> {
  const [cps, actions, dealParticipants, calendarEvents] = await Promise.all([
    supabase.from('cps').select('*').eq('user_id', USER_ID),
    supabase.from('action_proposals').select('*').eq('user_id', USER_ID).eq('status', 'pending'),
    supabase.from('deal_participants').select('*'),
    supabase.from('calendar_events').select('*').eq('user_id', USER_ID),
  ])
  return {
    cps: cps.data || [],
    actions: actions.data || [],
    dealParticipants: dealParticipants.data || [],
    calendarEvents: calendarEvents.data || [],
  }
}

// ─── Assertions ──────────────────────────────────────────────────────────────

interface Check { name: string; pass: boolean; detail: string }

function check(name: string, pass: boolean, detail = ''): Check {
  return { name, pass, detail }
}

function findCp(snap: Snapshot, nameContains: string): Row | undefined {
  const re = new RegExp(nameContains, 'i')
  return snap.cps.find(c =>
    re.test(String(c.name ?? '')) ||
    re.test(String(c.primary_identifier ?? '')),
  )
}

function actionsForCp(snap: Snapshot, cpId: string): Row[] {
  return snap.actions.filter(a => a.cp_id === cpId)
}

// Tomorrow morning in Prague: 05:00–11:00 UTC window covers 07:00–13:00 Prague
// (CEST in April). Lenient — signing is 09:00 Prague, Eva's call is 09–10 Prague.
function isTomorrowMorning(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  if (isNaN(d.getTime())) return false
  const now = new Date()
  const tomorrow = new Date(now); tomorrow.setUTCDate(now.getUTCDate() + 1)
  const sameDay =
    d.getUTCFullYear() === tomorrow.getUTCFullYear() &&
    d.getUTCMonth() === tomorrow.getUTCMonth() &&
    d.getUTCDate() === tomorrow.getUTCDate()
  if (!sameDay) return false
  const h = d.getUTCHours()
  return h >= 5 && h <= 11
}

function isTomorrow(iso: string | null | undefined): boolean {
  if (!iso) return false
  const d = new Date(iso)
  if (isNaN(d.getTime())) return false
  const now = new Date()
  const tomorrow = new Date(now); tomorrow.setUTCDate(now.getUTCDate() + 1)
  return (
    d.getUTCFullYear() === tomorrow.getUTCFullYear() &&
    d.getUTCMonth() === tomorrow.getUTCMonth() &&
    d.getUTCDate() === tomorrow.getUTCDate()
  )
}

function scheduleStart(a: Row): string | null {
  const payload = a.payload as Record<string, unknown> | null
  return (payload?.start as string) || (payload?.suggestedTime as string) || null
}

/**
 * Per-email bug assertions. Dispatched by cpKey.
 *
 * Each cpKey represents a known bug we want to catch in production behavior:
 *   - tomas:  "re: vacation" — must NOT schedule viewing while he's in Croatia
 *   - lawyer: "needs docs"   — must produce TODO, not a meeting SCHEDULE
 *   - bob:    "price Q"      — REPLY placeholder must address price/budget
 *   - eva:    "signing push" — SCHEDULE at tomorrow morning (CP's requested time)
 *   - urgent: "signing tmrw 9:00 at notary" — SCHEDULE urgency≥9 at tomorrow 9:00 Prague
 *   - martin: "close-by date change" — not currently bug-asserted
 */
function assertionsAfter(e: RealityEmail, snap: Snapshot): Check[] {
  const checks: Check[] = []

  switch (e.cpKey) {
    case 'tomas': {
      const cp = findCp(snap, 'Tom[áa][šs]|Hor[áa]k')
      checks.push(check('tomas: cp exists', !!cp))
      if (!cp) break
      const cards = actionsForCp(snap, cp.id as string)
      const scheduledTomorrow = cards.filter(a =>
        a.action_type === 'SCHEDULE' && isTomorrow(scheduleStart(a)),
      )
      checks.push(check(
        'tomas.no-schedule-while-on-vacation',
        scheduledTomorrow.length === 0,
        scheduledTomorrow.length
          ? `${scheduledTomorrow.length} SCHEDULE card(s) booked tomorrow — he's in Chorvatsko until May 5`
          : '',
      ))
      break
    }

    case 'lawyer': {
      const cp = findCp(snap, 'Krej[cč][íi]|JUDr')
      checks.push(check('lawyer: cp exists', !!cp))
      if (!cp) break
      const cards = actionsForCp(snap, cp.id as string)
      const todos = cards.filter(a => a.action_type === 'TODO')
      const schedules = cards.filter(a => a.action_type === 'SCHEDULE')
      checks.push(check(
        'lawyer.todo-exists',
        todos.length > 0,
        todos.length ? '' : 'expected TODO for doc delivery',
      ))
      checks.push(check(
        'lawyer.no-schedule',
        schedules.length === 0,
        schedules.length ? `unexpected SCHEDULE: ${schedules.map(s => s.intent_cs).join(' / ')}` : '',
      ))
      break
    }

    case 'bob': {
      const cp = findCp(snap, 'Bob')
      checks.push(check('bob: cp exists', !!cp))
      if (!cp) break
      const cards = actionsForCp(snap, cp.id as string)
      const replies = cards.filter(a => a.action_type === 'REPLY')
      checks.push(check('bob.reply-exists', replies.length > 0))
      if (replies.length > 0) {
        const bodies = replies.map(r =>
          `${r.intent_cs ?? ''} ${r.draft_body_text ?? ''}`,
        ).join(' ').toLowerCase()
        const addressesPrice = /cena|price|budget|rozpo[čc]et|kolik|nab[ií]dk/i.test(bodies)
        const proposesMeeting = /sch[uů]zk|prohl[ií]dk|setkat|vid[ěe]t|meeting|viewing|zaj[ií]t/i.test(bodies)
        checks.push(check(
          'bob.reply-addresses-price',
          addressesPrice,
          addressesPrice ? '' : `REPLY body doesn't mention price/budget: "${bodies.slice(0, 200)}"`,
        ))
        checks.push(check(
          'bob.reply-not-meeting-pitch',
          !proposesMeeting,
          proposesMeeting ? `REPLY body pitches a meeting: "${bodies.slice(0, 200)}"` : '',
        ))
      }
      break
    }

    case 'eva': {
      const cp = findCp(snap, 'Eva|Dvo[řr]')
      checks.push(check('eva: cp exists', !!cp))
      if (!cp) break
      const cards = actionsForCp(snap, cp.id as string)
      const schedules = cards.filter(a => a.action_type === 'SCHEDULE')
      checks.push(check('eva.schedule-exists', schedules.length > 0))
      const atRequestedTime = schedules.filter(a => isTomorrowMorning(scheduleStart(a)))
      checks.push(check(
        'eva.schedule-at-cp-requested-time',
        atRequestedTime.length > 0,
        atRequestedTime.length
          ? ''
          : `no SCHEDULE at tomorrow morning; starts=${schedules.map(scheduleStart).join(', ')}`,
      ))
      checks.push(check(
        'eva.schedule-urgency',
        schedules.some(a => (a.urgency as number) >= 8),
        `urgencies=${schedules.map(a => a.urgency).join(', ')}`,
      ))
      break
    }

    case 'urgent': {
      const cp = findCp(snap, 'Novotn[yý]')
      checks.push(check('urgent: cp exists', !!cp))
      if (!cp) break
      const cards = actionsForCp(snap, cp.id as string)
      const schedules = cards.filter(a => a.action_type === 'SCHEDULE')
      checks.push(check(
        'urgent.schedule-exists',
        schedules.length > 0,
        schedules.length ? '' : 'no SCHEDULE for signing tomorrow',
      ))
      checks.push(check(
        'urgent.schedule-urgency-9plus',
        schedules.some(a => (a.urgency as number) >= 9),
        `urgencies=${schedules.map(a => a.urgency).join(', ')}`,
      ))
      const atSigning = schedules.filter(a => isTomorrowMorning(scheduleStart(a)))
      checks.push(check(
        'urgent.schedule-at-notary-time',
        atSigning.length > 0,
        atSigning.length
          ? ''
          : `no SCHEDULE tomorrow morning; starts=${schedules.map(scheduleStart).join(', ')}`,
      ))
      const intents = schedules.map(a => String(a.intent_cs ?? '').toLowerCase()).join(' | ')
      const isGeneric = /úvodn[ií]\s*sch[uů]zk|first\s*meeting|intro/i.test(intents)
      const namesSigning = /podpis|sign|not[áa][řr]/i.test(intents)
      checks.push(check(
        'urgent.intent-names-signing',
        namesSigning && !isGeneric,
        `intents="${intents}"`,
      ))
      break
    }

    default:
      // martin + any others: no bug assertions yet — skip silently.
      break
  }

  return checks
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mila E2E Reality — Production-Realism Test')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  User:     ${USER_ID}`)
  console.log(`  Target:   ${BASE_URL}`)
  console.log(`  Run ID:   ${RUN_ID}`)
  console.log(`  Emails:   ${REALITY_EMAILS.length}`)
  console.log('═══════════════════════════════════════════════════════')

  if (REALITY_EMAILS.length === 0) {
    console.error('\nNo fixtures in e2e-reality-fixtures.ts. Populate REALITY_EMAILS first.')
    process.exit(1)
  }

  console.log('\n─── Phase 0: Inject history threads ────────────────────')
  for (const { label, emails } of ALL_HISTORY_THREADS) {
    await injectHistoryThread(emails, label)
  }

  console.log('\n─── Phase 0: Bulk ingest (context only) ────────────────')
  await bulkIngest()

  console.log('\n─── Phase 0: Self-email command ────────────────────────')
  await injectSelfEmail()

  console.log('\n─── Phase 1: Serial per-email runs ─────────────────────')
  const allChecks: { email: string; checks: Check[] }[] = []

  for (let i = 0; i < REALITY_EMAILS.length; i++) {
    const e = REALITY_EMAILS[i]
    console.log(`\n─── Email ${i + 1}/${REALITY_EMAILS.length}: ${e.cpKey} ─────────────────`)
    console.log(`  inject: "${e.subjectSuffix.slice(0, 60)}"`)
    await injectEmail(e, i)
    await new Promise(r => setTimeout(r, 3000)) // Gmail indexing

    console.log(`  agent...`)
    const agent = await runAgent()
    console.log(`  → success=${agent.success} ingested=${agent.emailsIngested} actions=${agent.actionsGenerated}`)
    if (!agent.success) {
      console.error(`  errors: ${agent.errors?.join(', ')}`)
    }

    const snap = await captureState()
    const checks = assertionsAfter(e, snap)
    allChecks.push({ email: e.cpKey, checks })

    if (checks.length === 0) {
      console.log(`  (no bug assertions for cpKey=${e.cpKey})`)
    } else {
      for (const c of checks) {
        const icon = c.pass ? '✓' : '✗'
        console.log(`  ${icon} ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
      }
    }
  }

  console.log('\n─── Phase 2: Trigger morning brief ─────────────────────')
  const briefRes = await fetch(`${BASE_URL}/api/cron/morning-brief?userId=${USER_ID}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${CRON_SECRET}` },
  })
  const briefBody = await briefRes.text()
  console.log(`  brief status=${briefRes.status}`)
  console.log(`  brief body=${briefBody.slice(0, 500)}`)

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  REALITY BUG SUMMARY')
  console.log('═══════════════════════════════════════════════════════')
  let totalPass = 0, totalFail = 0
  for (const { email, checks } of allChecks) {
    const pass = checks.filter(c => c.pass).length
    const fail = checks.length - pass
    totalPass += pass; totalFail += fail
    if (checks.length === 0) continue
    console.log(`  ${email}: ${pass}/${checks.length} pass${fail ? ` — ${fail} BUG(S)` : ''}`)
    for (const c of checks.filter(c => !c.pass)) {
      console.log(`     ✗ ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
    }
  }
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  TOTAL: ${totalPass} pass, ${totalFail} fail`)
  console.log('═══════════════════════════════════════════════════════')

  if (totalFail > 0) process.exit(1)
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
