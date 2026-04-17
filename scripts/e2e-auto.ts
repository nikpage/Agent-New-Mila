#!/usr/bin/env npx tsx
/**
 * E2E Auto-Runner — Headless acceptance test.
 *
 * Runs the full pipeline once:
 *   1. Inject 4 history threads → bulk ingest (context only, no actions)
 *   2. Inject self-email command ("Mila: nový kontakt")
 *   3. Inject 5 current emails + 1 urgent → agent run
 *   4. Snapshot DB state (deals, entity_map, journal, cps, actions, graph)
 *   5. Run assertion block (GROUND TRUTH — fill in below)
 *
 * No pauses, no browser URLs, no Round 2. Cassette-safe (intercepts LLM later).
 *
 * Usage: npx tsx scripts/e2e-auto.ts [userId]
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { google, gmail_v1 } from 'googleapis'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getAuthenticatedClient } from '../src/lib/google/auth'
import {
  ALL_HISTORY_THREADS,
  ALL_CURRENT_EMAILS,
  SELF_EMAIL_COMMAND,
  type FixtureHistoryEmail,
  type FixtureCurrentEmail,
} from './e2e-fixtures'

// ─── Config ──────────────────────────────────────────────────────────────────

const USER_ID = process.argv[2] || '9e59bc06-7276-453d-bc2e-f224a0a327e3'
const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.APP_BASE_URL ||
  'http://localhost:3000'
const API_KEY = process.env.MILA_USER_API_KEY || ''
const CRON_SECRET = process.env.CRON_SECRET || ''
const RUN_ID = `E2E-AUTO-${Date.now()}`

if (!API_KEY) { console.error('MILA_USER_API_KEY not set'); process.exit(1) }
if (!CRON_SECRET) { console.error('CRON_SECRET not set'); process.exit(1) }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); process.exit(1)
}

const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
)

// ─── Gmail plumbing (copied narrow from e2e-test.ts) ─────────────────────────

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

// ─── Injection ───────────────────────────────────────────────────────────────

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
    const rfcId = `<${RUN_ID}-hist-${label}-${i}@e2e-auto.local>`
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

async function injectCurrentEmail(e: FixtureCurrentEmail): Promise<void> {
  const gmail = await gmailClient()
  const me = await userEmail()
  const rfcId = `<${RUN_ID}-curr-${e.cpKey}@e2e-auto.local>`
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
  console.log(`  [current] ${e.cpKey}: "${e.subjectSuffix.slice(0, 50)}"`)
}

async function injectSelfEmail(): Promise<void> {
  const gmail = await gmailClient()
  const me = await userEmail()
  const rfcId = `<${RUN_ID}-self@e2e-auto.local>`
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

// ─── Pipeline calls ──────────────────────────────────────────────────────────

async function bulkIngest(): Promise<void> {
  const since = new Date(); since.setDate(since.getDate() - 40)
  const res = await fetch(`${BASE_URL}/api/ingest/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ userId: USER_ID, since: since.toISOString(), maxTotal: 100 }),
    signal: AbortSignal.timeout(600_000),
  })
  if (!res.ok) throw new Error(`bulk ingest failed: HTTP ${res.status}`)
  console.log(`  [bulk] history ingested`)
}

interface AgentResult {
  success: boolean
  emailsIngested: number
  messagesProcessed: number
  conversationsUpdated: number
  actionsGenerated: number
  followUpsGenerated: number
  coolingLeads: number
  coldLeads: number
  reflectionObservations: number
  actions: Array<{ id: string; action_type: string; urgency: number; priority_score: number; intent_cs: string | null }>
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

// ─── DB snapshot ─────────────────────────────────────────────────────────────

export interface RunState {
  runId: string
  agent: AgentResult
  deals: Array<Record<string, unknown>>
  cps: Array<Record<string, unknown>>
  entityMap: Array<Record<string, unknown>>
  journalEntries: Array<Record<string, unknown>>
  actions: Array<Record<string, unknown>>
  graphNodes: Array<Record<string, unknown>>
  graphEdges: Array<Record<string, unknown>>
  threads: Array<Record<string, unknown>>
}

async function captureState(agent: AgentResult): Promise<RunState> {
  const [deals, cps, entityMap, journal, actions, threads] = await Promise.all([
    supabase.from('deals').select('*').eq('user_id', USER_ID),
    supabase.from('cps').select('*').eq('user_id', USER_ID),
    supabase.from('entity_map').select('*').eq('user_id', USER_ID),
    supabase.from('journal_entries').select('*').eq('user_id', USER_ID),
    supabase.from('action_proposals').select('*').eq('user_id', USER_ID).eq('status', 'pending'),
    supabase.from('conversation_threads').select('*').eq('user_id', USER_ID),
  ])

  const dealIds = (deals.data || []).map(d => d.id as string)
  const [nodes, edges] = dealIds.length
    ? await Promise.all([
        supabase.from('deal_graph_nodes').select('*').in('deal_id', dealIds),
        supabase.from('deal_graph_edges').select('*').in('deal_id', dealIds),
      ])
    : [{ data: [] }, { data: [] }]

  return {
    runId: RUN_ID,
    agent,
    deals: deals.data || [],
    cps: cps.data || [],
    entityMap: entityMap.data || [],
    journalEntries: journal.data || [],
    actions: actions.data || [],
    graphNodes: nodes.data || [],
    graphEdges: edges.data || [],
    threads: threads.data || [],
  }
}

// ─── Assertions ──────────────────────────────────────────────────────────────

interface Check { name: string; pass: boolean; detail: string }

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GROUND TRUTH ASSERTIONS
 * ═══════════════════════════════════════════════════════════════════════════
 */

type Row = Record<string, unknown>

function findCp(state: RunState, nameContains: string): Row | undefined {
  const re = new RegExp(nameContains, 'i')
  return state.cps.find(c => re.test(String(c.name ?? '')) || re.test(String(c.email ?? '')))
}

function dealsForCp(state: RunState, cpId: string): Row[] {
  return state.deals.filter(d => d.cp_id === cpId || (Array.isArray(d.cp_ids) && (d.cp_ids as string[]).includes(cpId)))
}

function findDealByCpName(state: RunState, nameContains: string): Row | undefined {
  const cp = findCp(state, nameContains)
  if (!cp) return undefined
  const ds = dealsForCp(state, cp.id as string)
  return ds[0]
}

function entitiesFor(state: RunState, dealId: string): Row[] {
  return state.entityMap.filter(e => e.deal_id === dealId)
}

function hasEntity(state: RunState, dealId: string, typeRe: RegExp, keyRe: RegExp, valueRe?: RegExp): boolean {
  return entitiesFor(state, dealId).some(e =>
    typeRe.test(String(e.entity_type)) &&
    keyRe.test(String(e.entity_key)) &&
    (!valueRe || valueRe.test(String(e.entity_value))),
  )
}

function actionsFor(state: RunState, dealId: string): Row[] {
  return state.actions.filter(a => a.deal_id === dealId)
}

function nodesFor(state: RunState, dealId: string): Row[] {
  return state.graphNodes.filter(n => n.deal_id === dealId)
}

function hasNode(state: RunState, dealId: string, labelRe: RegExp, statusRe?: RegExp): boolean {
  return nodesFor(state, dealId).some(n =>
    labelRe.test(String(n.label ?? '')) &&
    (!statusRe || statusRe.test(String(n.status ?? ''))),
  )
}

function beliefsFor(state: RunState, dealId: string): Row[] {
  return state.journalEntries.filter(j => j.deal_id === dealId)
}

function threadsFor(state: RunState, cpId: string): Row[] {
  return state.threads.filter(t => t.cp_id === cpId)
}

function check(name: string, pass: boolean, detail = ''): Check {
  return { name, pass, detail }
}

function assertions(state: RunState): Check[] {
  const checks: Check[] = []

  checks.push(check('pipeline: agent.success', state.agent.success === true,
    state.agent.errors?.join(', ') || ''))

  // ─── NOVOTNÝ ───────────────────────────────────────────────────────────────
  const novCp = findCp(state, 'Novotný|Novotny')
  const novDeal = novCp ? dealsForCp(state, novCp.id as string)[0] : undefined
  const novId = novDeal?.id as string | undefined

  checks.push(check('nov: deal exists', !!novDeal))
  if (novId) {
    checks.push(check('nov.1a: price.asking 48M (original)',
      hasEntity(state, novId, /price/i, /ask/i, /48[\s.]?0{3}[\s.]?0{3}|48[\s.]?000[\s.]?000|\b48M\b/i)))
    checks.push(check('nov.1b: price.final/sale 45M (agreed)',
      hasEntity(state, novId, /price/i, /final|sale|agreed|dohod/i, /45[\s.]?0{3}[\s.]?0{3}|45[\s.]?000[\s.]?000|\b45M\b/i)))
    checks.push(check('nov.2a: address Vinohrady + Praha 2',
      hasEntity(state, novId, /property|address/i, /address|location/i, /vinohrad/i) &&
      entitiesFor(state, novId).some(e => /praha 2/i.test(String(e.entity_value)))))
    checks.push(check('nov.2b: area ≈ 1200 m2',
      hasEntity(state, novId, /property/i, /area|plocha|m2/i, /1[\s.]?200|1200/)))
    checks.push(check('nov.2c: floors = 6',
      hasEntity(state, novId, /property/i, /floor|podlaz/i, /\b6\b/)))
    checks.push(check('nov.3a: occupancy ≈ 85%',
      hasEntity(state, novId, /property/i, /occupancy|obsazen/i, /85/)))
    checks.push(check('nov.3b: rental income ≈ 180k/mo',
      hasEntity(state, novId, /property|income/i, /rent|income|najm|v[yý]nos/i, /180[\s.]?0{3}|180[\s.]?000/)))
    checks.push(check('nov.4a: notary datetime tomorrow 09:00',
      hasEntity(state, novId, /notary|not[áa][řr]/i, /datetime|time|when/i, /09:00|9:00|9.00/)))
    checks.push(check('nov.4b: notary name Procházka',
      hasEntity(state, novId, /notary|not[áa][řr]/i, /name/i, /proch[áa]zka/i)))
    checks.push(check('nov.4c: notary location Třinecká 672',
      hasEntity(state, novId, /notary|not[áa][řr]/i, /location|address/i, /t[řr]ineck[áa].*672/i)))
    checks.push(check('nov.5a: list_vlastnictví pending/overdue',
      hasEntity(state, novId, /doc|state/i, /list.?vlastnictv/i, /pending|overdue|unsent|missing/i)))
    checks.push(check('nov.5b: bezdlužnost_SVJ pending/overdue',
      hasEntity(state, novId, /doc|state/i, /bezdluzn|bezdl[uú]zn/i, /pending|overdue|unsent|missing/i)))
    checks.push(check('nov.5c: energetický_průkaz sent',
      hasEntity(state, novId, /doc|state/i, /energetick|pr[uů]kaz/i, /sent|done|delivered/i)))
    checks.push(check('nov.6a: offer_accepted completed',
      hasNode(state, novId, /offer.?accept/i, /complet|done/i)))
    checks.push(check('nov.6b: contract_drafted in_progress',
      hasNode(state, novId, /contract|smlouv/i, /in.?progress|pending/i)))
    checks.push(check('nov.6c: notary_scheduled',
      hasNode(state, novId, /notary|not[áa][řr]/i, /.*/)))
    checks.push(check('nov.6d: closing pending',
      hasNode(state, novId, /clos|uzavr/i, /pending|in.?progress/i)))
    checks.push(check('nov.7a: beliefs include breach/overdue signal',
      beliefsFor(state, novId).some(b => /overdue|breach|sl[íi]bil|unsent|missing|pozd/i.test(String(b.content ?? b.topic ?? ''))))  )
    checks.push(check('nov.7b: beliefs include aggressive/pressure posture',
      beliefsFor(state, novId).some(b => /aggressive|pressure|tlak|ultimat/i.test(String(b.content ?? b.topic ?? ''))))  )
    const novActions = actionsFor(state, novId)
    checks.push(check('nov.8: ≥3 cards', novActions.length >= 3, `${novActions.length} cards`))
    checks.push(check('nov.8a: SCHEDULE urgency=10 for notary',
      novActions.some(a => a.action_type === 'SCHEDULE' && (a.urgency as number) >= 9)))
    checks.push(check('nov.8b: REPLY urgency≥9',
      novActions.some(a => a.action_type === 'REPLY' && (a.urgency as number) >= 9)))
    checks.push(check('nov.8c: TODO for list_vlastnictví + bezdlužnost',
      novActions.some(a => a.action_type === 'TODO' &&
        /list.?vlastn|bezdluzn/i.test(String(a.intent_cs ?? '')))))
    checks.push(check('nov.9: top priority_score across R1',
      novActions.length > 0 &&
      Math.max(...novActions.map(a => a.priority_score as number)) ===
        Math.max(...state.actions.map(a => a.priority_score as number))))
    checks.push(check('nov.10a: lead tracking NOT cooling',
      !novActions.some(a => /cool|cold|dead/i.test(String(a.action_type))) &&
      !state.actions.some(a => a.cp_id === novCp?.id && /cool|cold|dead/i.test(String(a.action_type)))))
  }

  // ─── EVA ───────────────────────────────────────────────────────────────────
  const evaCp = findCp(state, 'Eva|Dvorak')
  const evaDeal = evaCp ? dealsForCp(state, evaCp.id as string)[0] : undefined
  const evaId = evaDeal?.id as string | undefined

  checks.push(check('eva: deal exists', !!evaDeal))
  if (evaId) {
    checks.push(check('eva.1: rent 450 CZK/m²',
      hasEntity(state, evaId, /price/i, /rent|najm|lease/i, /450/)))
    checks.push(check('eva.2a: lease duration 3 years',
      hasEntity(state, evaId, /lease/i, /duration|years/i, /\b3\b/)))
    checks.push(check('eva.2b: renewal option true',
      hasEntity(state, evaId, /lease/i, /renewal|opce|option/i, /true|ano|yes|market|trzni|tr[žz]n[íi]/i)))
    checks.push(check('eva.3a: address Sokolovská',
      hasEntity(state, evaId, /property|address/i, /address|location/i, /sokolov/i)))
    checks.push(check('eva.3b: area 200 m2',
      hasEntity(state, evaId, /property/i, /area|plocha/i, /200/)))
    checks.push(check('eva.3c: layout open plan + 2 zasedačky',
      entitiesFor(state, evaId).some(e => /open.?plan/i.test(String(e.entity_value)) &&
        /zaseda|2/i.test(String(e.entity_value)))))
    checks.push(check('eva.4: move_in ≈ mid-April',
      hasEntity(state, evaId, /commitment|move/i, /move.?in|nastehov|dubna/i, /duben|april|4|poloviny/i)))
    checks.push(check('eva.5a: open_issue notice_period 6 months',
      hasEntity(state, evaId, /open|issue|lease/i, /notice|v[yý]pov/i, /6/)))
    checks.push(check('eva.5b: open_issue parking 3 spots',
      hasEntity(state, evaId, /open|issue|park/i, /park/i, /3/)))
    checks.push(check('eva.6a: offer_accepted completed',
      hasNode(state, evaId, /offer.?accept|counter/i, /complet|done/i)))
    checks.push(check('eva.6b: contract_drafted in_progress',
      hasNode(state, evaId, /contract|smlouv/i, /in.?progress|pending/i)))
    checks.push(check('eva.6c: lawyer_review in_progress',
      hasNode(state, evaId, /lawyer|law|pr[áa]vn/i, /in.?progress|open/i)))
    checks.push(check('eva.6d: signing pending',
      hasNode(state, evaId, /sign|podpis/i, /pending|in.?progress/i)))
    checks.push(check('eva.7: beliefs friendly + open_issues',
      beliefsFor(state, evaId).some(b => /friendly|collab|ahoj|smile/i.test(String(b.content ?? b.topic ?? ''))) &&
      beliefsFor(state, evaId).some(b => /open.?issue|notice|park/i.test(String(b.content ?? b.topic ?? '')))))
    const evaActions = actionsFor(state, evaId)
    checks.push(check('eva.8: ≥2 cards', evaActions.length >= 2, `${evaActions.length} cards`))
    checks.push(check('eva.8a: SCHEDULE call tomorrow 9–10',
      evaActions.some(a => a.action_type === 'SCHEDULE' && (a.urgency as number) >= 8)))
    checks.push(check('eva.8b: TODO/REPLY prep lawyer points',
      evaActions.some(a => (a.action_type === 'TODO' || a.action_type === 'REPLY') &&
        /v[yý]pov|park|pr[áa]vn|smlouv/i.test(String(a.intent_cs ?? '')))))
    checks.push(check('eva.9: intent_cs names výpověď + parkování + podpis',
      evaActions.some(a => {
        const t = String(a.intent_cs ?? '').toLowerCase()
        return /v[yý]pov/i.test(t) || /park/i.test(t) || /podpis/i.test(t)
      })))
    checks.push(check('eva.10a: not cooling',
      !evaActions.some(a => /cool|cold|dead/i.test(String(a.action_type)))))
    checks.push(check('eva.10b: two subjects resolve to same cp',
      evaCp ? threadsFor(state, evaCp.id as string).length >= 1 : false))
  }

  // ─── KLÁRA ─────────────────────────────────────────────────────────────────
  const klaCp = findCp(state, 'Kl[áa]ra|Marcin')
  const klaDeal = klaCp ? dealsForCp(state, klaCp.id as string)[0] : undefined
  const klaId = klaDeal?.id as string | undefined

  checks.push(check('kla: deal exists', !!klaDeal))
  if (klaId) {
    checks.push(check('kla.1a: asking 9.8M',
      hasEntity(state, klaId, /price/i, /ask/i, /9[\s.,]?8|9[\s.]?800/)))
    checks.push(check('kla.1b: user_final_limit 9.5M',
      hasEntity(state, klaId, /price/i, /final|limit|counter/i, /9[\s.,]?5|9[\s.]?500/)))
    checks.push(check('kla.2a: address Antonínská 12 Dejvice',
      hasEntity(state, klaId, /property|address/i, /address|location/i, /anton[íi]nsk|dejvice/i)))
    checks.push(check('kla.2b: area 280 m2',
      hasEntity(state, klaId, /property/i, /area|plocha/i, /280/)))
    checks.push(check('kla.2c: pozemek 650 m2',
      hasEntity(state, klaId, /property/i, /pozemek|land|plot/i, /650/)))
    checks.push(check('kla.2d: dispozice 5+1',
      hasEntity(state, klaId, /property/i, /disposit|layout|dispozic/i, /5\+1/)))
    checks.push(check('kla.3a: rekonstrukce 2021',
      hasEntity(state, klaId, /property/i, /condition|rekonstr/i, /2021/)))
    checks.push(check('kla.3b: roof 2019',
      hasEntity(state, klaId, /property/i, /roof|strecha/i, /2019/)))
    checks.push(check('kla.4: move_in do konce června',
      hasEntity(state, klaId, /commitment|move/i, /move.?in|nastehov/i, /2026-06-30|cerven|june|konce/i)))
    checks.push(check('kla.5: viewing_2 pending (with parents)',
      hasEntity(state, klaId, /viewing|prohl[íi]dk/i, /viewing_?2|druh|parent|rodi/i)))
    checks.push(check('kla.6: contact has email but no phone',
      klaCp && !(klaCp.phone) && /@/.test(String(klaCp.email ?? ''))))
    checks.push(check('kla.7: graph has silent/awaiting state',
      nodesFor(state, klaId).some(n => /cp.?response|await|silent|negot/i.test(String(n.label ?? ''))) ||
      nodesFor(state, klaId).some(n => /await|silent|pending/i.test(String(n.status ?? '')))))
    checks.push(check('kla.8: beliefs include financing + price_sensitivity',
      beliefsFor(state, klaId).some(b => /financ|parent|rodi|rozpoc/i.test(String(b.content ?? b.topic ?? ''))) &&
      beliefsFor(state, klaId).some(b => /price.?sensit|hesit|cena|hran/i.test(String(b.content ?? b.topic ?? ''))))  )
    const klaActions = actionsFor(state, klaId)
    checks.push(check('kla.9: COOLING flagged',
      (state.agent.coolingLeads ?? 0) > 0 ||
      klaActions.some(a => /cool/i.test(String(a.action_type))) ||
      threadsFor(state, klaCp!.id as string).some(t => /cool/i.test(String(t.lead_status ?? '')))))
    checks.push(check('kla.10: one REPLY card urgency ≤4',
      klaActions.length === 1 && klaActions[0].action_type === 'REPLY' &&
      (klaActions[0].urgency as number) <= 4))
  }

  // ─── TOMÁŠ ─────────────────────────────────────────────────────────────────
  const tomCp = findCp(state, 'Tom[áa][šs]|Hor[áa]k')
  const tomDeal = tomCp ? dealsForCp(state, tomCp.id as string)[0] : undefined
  const tomId = tomDeal?.id as string | undefined

  checks.push(check('tom: deal exists', !!tomDeal))
  if (tomId) {
    checks.push(check('tom.1a: asking 6.9M',
      hasEntity(state, tomId, /price/i, /ask/i, /6[\s.,]?9|6[\s.]?900/)))
    checks.push(check('tom.1b: buyer budget 6.5M',
      hasEntity(state, tomId, /price|buyer/i, /budget|rozpoc/i, /6[\s.,]?5|6[\s.]?500/)))
    checks.push(check('tom.2a: address Na Popelce / Košíře',
      hasEntity(state, tomId, /property|address/i, /address|location/i, /popelc|kosir|ko[šs][íi][řr]/i)))
    checks.push(check('tom.2b: area 78 m2',
      hasEntity(state, tomId, /property/i, /area|plocha/i, /78/)))
    checks.push(check('tom.2c: zahrada 45 m2',
      hasEntity(state, tomId, /property/i, /zahrad|garden/i, /45/)))
    checks.push(check('tom.2d: dispozice 3+kk',
      hasEntity(state, tomId, /property/i, /disposit|layout|dispozic/i, /3\+kk/)))
    checks.push(check('tom.3: revisit 2026-05-05',
      hasEntity(state, tomId, /commit|revisit|cp_status/i, /revisit|avail|return/i, /2026-05-05|5[\s.]?kv[ěe]tn|may/i)))
    checks.push(check('tom.4a: on_vacation',
      hasEntity(state, tomId, /cp|status/i, /avail|vacation|dovolen/i, /vacation|dovolen|on_vac|chorv/i)))
    checks.push(check('tom.4b: location Chorvatsko',
      hasEntity(state, tomId, /cp|status/i, /location/i, /chorvat|croatia/i)))
    checks.push(check('tom.5: contact email only, no phone',
      tomCp && !(tomCp.phone)))
    checks.push(check('tom.6: viewing deferred',
      hasNode(state, tomId, /viewing|prohl[íi]dk/i, /defer|request|pending/i)))
    checks.push(check('tom.7: beliefs casual + buyer_interest high',
      beliefsFor(state, tomId).some(b => /casual|friendly|ahoj|super/i.test(String(b.content ?? b.topic ?? ''))) &&
      beliefsFor(state, tomId).some(b => /interest|zajem|high/i.test(String(b.content ?? b.topic ?? ''))))  )
    checks.push(check('tom.8: conversation SNOOZED',
      tomCp && threadsFor(state, tomCp.id as string).some(t => !!t.snooze_until)))
    const tomActions = actionsFor(state, tomId)
    checks.push(check('tom.9: no REPLY/SCHEDULE today',
      !tomActions.some(a => a.action_type === 'REPLY' || a.action_type === 'SCHEDULE')))
  }

  // ─── KREJČÍ (lawyer service CP) ────────────────────────────────────────────
  const krejCp = findCp(state, 'Krej[cč][íi]|JUDr')
  checks.push(check('krej: cp exists', !!krejCp))
  if (krejCp) {
    checks.push(check('krej.1: role = lawyer/service',
      /lawyer|service|pr[áa]vn/i.test(String(krejCp.role ?? ''))))
    checks.push(check('krej.2a: title JUDr.',
      /JUDr/i.test(String(krejCp.name ?? '')) || /JUDr/i.test(String(krejCp.title ?? ''))))
    checks.push(check('krej.2b: company Krejčí & Partners',
      /krej[cč][íi].*partners|krej[cč][íi][\s&]/i.test(String(krejCp.company ?? ''))))
    checks.push(check('krej.2c: office Národní 18',
      /n[áa]rodn[íi].*18/i.test(String(krejCp.office_address ?? krejCp.address ?? ''))))
    checks.push(check('krej.5: NOT flagged cooling/cold/dead',
      !state.actions.some(a => a.cp_id === krejCp.id && /cool|cold|dead/i.test(String(a.action_type)))))
  }

  // ─── BOB ───────────────────────────────────────────────────────────────────
  const bobCp = findCp(state, 'Bob')
  const bobDeal = bobCp ? dealsForCp(state, bobCp.id as string)[0] : undefined
  const bobId = bobDeal?.id as string | undefined

  checks.push(check('bob: cp + deal exists', !!bobDeal))
  if (bobId) {
    checks.push(check('bob.1: address Vinohradská 45',
      hasEntity(state, bobId, /property|address/i, /address|location/i, /vinohradsk.*45/i)))
    checks.push(check('bob.2: buyer_budget ≈ 8.5M',
      hasEntity(state, bobId, /price|buyer/i, /budget|rozpoc/i, /8[\s.,]?5|8[\s.]?500/)))
    checks.push(check('bob.3: no phone/company',
      bobCp && !bobCp.phone && !bobCp.company))
    checks.push(check('bob.4: beliefs low urgency + exploratory',
      beliefsFor(state, bobId).some(b => /low|spech|nespe|explor|zvazuj/i.test(String(b.content ?? b.topic ?? ''))))  )
    const bobActions = actionsFor(state, bobId)
    checks.push(check('bob.6: REPLY urgency ≤3',
      bobActions.some(a => a.action_type === 'REPLY' && (a.urgency as number) <= 3)))
  }

  // ─── MARTIN KRÁL ───────────────────────────────────────────────────────────
  const marCp = findCp(state, 'Kr[áa]l|Martin')
  const marDeal = marCp ? dealsForCp(state, marCp.id as string)[0] : undefined
  const marId = marDeal?.id as string | undefined

  checks.push(check('mar: cp + deal exists', !!marDeal))
  if (marId) {
    checks.push(check('mar.1a: address Smíchov',
      hasEntity(state, marId, /property|address/i, /address|location/i, /sm[íi]chov/i)))
    checks.push(check('mar.1b: price 12.4M',
      hasEntity(state, marId, /price/i, /./, /12[\s.,]?4|12[\s.]?400/)))
    checks.push(check('mar.2: close_by 2026-04-30',
      hasEntity(state, marId, /commit|clos/i, /clos|uzavr|konce/i, /2026-04-30|duben|april|dubna/i)))
    checks.push(check('mar.3: bank_docs ~2 weeks window',
      hasEntity(state, marId, /commit|bank|financ/i, /bank|dok|docs|financ/i, /2026-05-01|dvou.?tyd|two.?week|2.?week/i)))
    const marActions = actionsFor(state, marId)
    checks.push(check('mar.7a: REPLY confirming financing',
      marActions.some(a => a.action_type === 'REPLY' && /financ|pripra|ready/i.test(String(a.intent_cs ?? '')))))
    checks.push(check('mar.7b: TODO for bank docs',
      marActions.some(a => a.action_type === 'TODO' && /bank|doku|dok|financ/i.test(String(a.intent_cs ?? '')))))
  }

  // ─── PETR SVOBODA (self-email command) ─────────────────────────────────────
  const petrCp = findCp(state, 'Petr|Svoboda')
  checks.push(check('petr.2: cp created name + role=buyer', !!petrCp &&
    /buyer/i.test(String(petrCp.role ?? ''))))
  if (petrCp) {
    checks.push(check('petr.3a: email petr.svoboda@remax.cz',
      /petr\.svoboda@remax/i.test(String(petrCp.email ?? ''))))
    checks.push(check('petr.3b: phone 602 555 123',
      /602[\s.]?555[\s.]?123/.test(String(petrCp.phone ?? '').replace(/\D/g, '') || String(petrCp.phone ?? '')) ||
      String(petrCp.phone ?? '').replace(/\D/g, '').includes('602555123')))
    const petrDeals = dealsForCp(state, petrCp.id as string)
    const petrActions = state.actions.filter(a => a.cp_id === petrCp.id)
    checks.push(check('petr.5: no conversation/cards',
      petrDeals.length === 0 && petrActions.length === 0))
  }

  return checks
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mila E2E Auto — Headless Acceptance Test')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  User:     ${USER_ID}`)
  console.log(`  Target:   ${BASE_URL}`)
  console.log(`  Run ID:   ${RUN_ID}`)
  console.log('═══════════════════════════════════════════════════════')

  console.log('\n─── Phase 0: Inject history threads ────────────────────')
  for (const { label, emails } of ALL_HISTORY_THREADS) {
    await injectHistoryThread(emails, label)
  }

  console.log('\n─── Phase 0: Bulk ingest (context only) ────────────────')
  await bulkIngest()

  console.log('\n─── Phase 0: Self-email command ────────────────────────')
  await injectSelfEmail()

  console.log('\n─── Phase 1: Inject current emails ─────────────────────')
  for (const e of ALL_CURRENT_EMAILS) await injectCurrentEmail(e)
  await new Promise(r => setTimeout(r, 3000)) // Gmail indexing

  console.log('\n─── Phase 2: Run agent ─────────────────────────────────')
  const agent = await runAgent()
  console.log(`  emailsIngested=${agent.emailsIngested} actions=${agent.actionsGenerated} cooling=${agent.coolingLeads} journal=${agent.reflectionObservations}`)

  console.log('\n─── Phase 3: Snapshot DB state ─────────────────────────')
  const state = await captureState(agent)
  console.log(`  deals=${state.deals.length} cps=${state.cps.length} entities=${state.entityMap.length} journal=${state.journalEntries.length} actions=${state.actions.length} nodes=${state.graphNodes.length} edges=${state.graphEdges.length}`)

  console.log('\n─── Phase 4: Assertions ────────────────────────────────')
  const checks = assertions(state)
  let passed = 0
  for (const c of checks) {
    const icon = c.pass ? '✓' : '✗'
    console.log(`  ${icon} ${c.name}: ${c.detail}`)
    if (c.pass) passed++
  }

  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  RESULT: ${passed}/${checks.length} checks passed`)
  console.log('═══════════════════════════════════════════════════════')

  if (passed !== checks.length) process.exit(1)
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
