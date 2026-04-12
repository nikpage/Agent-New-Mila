/**
 * Triage Eval Harness
 *
 * Runs triageConversation against a labeled dataset of known-correct decisions.
 * Each test case comes from a real bug that was fixed in production.
 *
 * Usage:
 *   npx tsx scripts/eval-triage.ts
 *   npx tsx scripts/eval-triage.ts --case 3    # run single case
 *   npx tsx scripts/eval-triage.ts --json       # machine-readable output
 *
 * Run this BEFORE and AFTER any triage prompt change. If pass rate drops, revert.
 */

import { triageConversation, type EnrichedMessageData } from '../src/lib/ai/gemini'
import type { ConversationSummary, UserSettings } from '../src/lib/supabase/types'

// ─── Minimal settings stub (enough for triage to run) ──────────────────────

const TEST_SETTINGS = {
  client_name: 'Test Agent',
  client_company: 'Test Reality s.r.o.',
  client_role: 'real estate agent',
  client_phone: '+420777000000',
  client_whatsapp: '+420777000000',
  business_type: 'real estate',
  business_specialization: 'residential real estate',
  business_market: 'Prague',
  ai_language: 'Czech',
  ai_name: 'Mila',
  ai_tone_user: 'professional and concise',
  ai_tone_cp: 'polite and formal',
  ai_email_signature: 'S pozdravem, Mila',
  ai_system_context: '',
  timezone: 'Europe/Prague',
  typical_deal_size_min: 2000000,
  typical_deal_size_max: 15000000,
  typical_deal_size_currency: 'CZK',
  kc_high_value: 5000000,
  kc_low_value: 500000,
  office_location: 'Dykova 17, Praha 2',
  home_location: '',
  lawyer_notary: 'JUDr. Procházka, Národní 10, Praha 1',
  offer_multiplier_seller: 1.5,
  offer_multiplier_buyer: 1.0,
  priority_multiplier_vip: 2.0,
  working_hours_start: 8,
  working_hours_end: 18,
  working_days: [1, 2, 3, 4, 5],
  morning_brief_time: '08:00',
  afternoon_brief_time: '13:00',
  default_meeting_duration: 60,
  default_meeting_type: 'online' as const,
  meeting_buffer_minutes: 15,
  travel_mode: 'driving' as const,
  high_value_signals: ['exclusive', 'penthouse', 'investiční'],
  low_priority_signals: [],
  default_delegate_email: null,
  todo_auto_due_days: 1,
  user_alias: 'User',
} as UserSettings

// ─── Test case type ────────────────────────────────────────────────────────

interface EvalCase {
  id: number
  name: string
  sourceCommit: string
  latestInbound: string
  recentMessages: { direction: string; text: string; age: string }[]
  summary: ConversationSummary | null
  pendingActions: { type: string; intent: string; urgency: number }[]
  cpName: string
  channel: 'email' | 'whatsapp'
  enrichment: EnrichedMessageData | null
  journalText: string
  assert: {
    needs_action?: boolean
    type?: 'REPLY' | 'SCHEDULE' | 'TODO'
    urgency_category?: 'CRITICAL' | 'TODAY' | 'THIS_WEEK' | 'SOON' | 'NONE'
    venue_index?: number | null
    time_index?: number | null
    no_action?: boolean
    intent_contains?: string
    intent_not_contains?: string
    max_missing_info?: number
    has_revisit?: boolean
  }
}

// ─── Test cases (each from a real production bug) ──────────────────────────

const EVAL_CASES: EvalCase[] = [
  {
    id: 1,
    name: 'Address in body must be verbatim, not hallucinated',
    sourceCommit: '0100e4f',
    latestInbound: 'Dobrý den, rád bych se podíval na byt na Třinecké 672, Praha 10. Můžeme se domluvit na prohlídku? Děkuji, Jan Novotný',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, rád bych se podíval na byt na Třinecké 672, Praha 10. Můžeme se domluvit na prohlídku? Děkuji, Jan Novotný', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Jan Novotný',
    channel: 'email',
    enrichment: {
      parties: ['Jan Novotný'],
      subject: 'Prohlídka bytu',
      messageType: 'meeting_request',
      coreIntent: 'Žádost o prohlídku bytu na Třinecké 672',
      addresses: ['Třinecká 672, Praha 10'],
      proposedTimes: [],
      meetingType: 'prohlídka bytu',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      venue_index: 0,
    },
  },

  {
    id: 2,
    name: 'Hard deadline "potvrďte do 17:00" must produce CRITICAL/TODAY urgency',
    sourceCommit: '0100e4f',
    latestInbound: 'Dobrý den, potřebuji od vás potvrzení rezervace do 17:00 dnes, jinak nabídka propadá. Cena 4 500 000 Kč. S pozdravem, Eva Malá',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, potřebuji od vás potvrzení rezervace do 17:00 dnes, jinak nabídka propadá. Cena 4 500 000 Kč. S pozdravem, Eva Malá', age: 'today' },
    ],
    summary: { currentState: 'Jednání o koupi bytu', risks: [], nextSteps: [], keyPoints: [], confidence: 0.8, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Eva Malá',
    channel: 'email',
    enrichment: {
      parties: ['Eva Malá'],
      subject: 'Potvrzení rezervace',
      coreIntent: 'Požadavek na potvrzení rezervace do 17:00',
      addresses: [],
      proposedTimes: [],
      urgency: { quote: 'potvrďte do 17:00 dnes, jinak nabídka propadá', classification: 'HARD DEADLINE' },
      keyNumbers: { price: '4 500 000 Kč' },
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'REPLY',
      urgency_category: 'CRITICAL',
    },
  },

  {
    id: 3,
    name: 'Confirmation email must NOT produce action',
    sourceCommit: '7081204',
    latestInbound: 'Děkuji, domluveno. Těším se na schůzku v úterý. Hezký den, Pavel',
    recentMessages: [
      { direction: 'outbound', text: 'Pane Pavle, navrhoval bych schůzku v úterý v 10:00 v naší kanceláři. Vyhovuje vám to?', age: '1d ago' },
      { direction: 'inbound', text: 'Děkuji, domluveno. Těším se na schůzku v úterý. Hezký den, Pavel', age: 'today' },
    ],
    summary: { currentState: 'Schůzka domluvena na úterý', risks: [], nextSteps: ['Schůzka v úterý'], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [{ type: 'SCHEDULE', intent: 'Domluvit schůzku s Pavlem', urgency: 5 }],
    cpName: 'Pavel',
    channel: 'email',
    enrichment: {
      parties: ['Pavel'],
      subject: 'Potvrzení schůzky',
      messageType: 'confirmation',
      coreIntent: 'Potvrzení domluvené schůzky',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      no_action: true,
    },
  },

  {
    id: 4,
    name: 'CP asks to confirm AND prepare docs → TODO surfaces first',
    sourceCommit: 'b01f1bc',
    latestInbound: 'Dobrý den, schůzka u notáře je naplánována na čtvrtek v 14:00. Prosím přineste výpis z katastru a ověřenou plnou moc. Adresa: Národní 10, Praha 1.',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, schůzka u notáře je naplánována na čtvrtek v 14:00. Prosím přineste výpis z katastru a ověřenou plnou moc. Adresa: Národní 10, Praha 1.', age: 'today' },
    ],
    summary: { currentState: 'Příprava podpisu u notáře', risks: [], nextSteps: [], keyPoints: [], confidence: 0.8, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'JUDr. Procházka',
    channel: 'email',
    enrichment: {
      parties: ['JUDr. Procházka'],
      subject: 'Schůzka u notáře',
      messageType: 'meeting_request',
      coreIntent: 'Pozvání na podpis u notáře, požadavek na dokumenty',
      addresses: ['Národní 10, Praha 1'],
      proposedTimes: [{ original: 'čtvrtek v 14:00', interpreted: 'čtvrtek 14:00', relativeRef: 'specific_day', dayOfWeek: 'thursday', timeOfDay: '14:00', eventContext: 'notary' }],
      meetingType: 'podpis u notáře',
      urgency: { quote: 'schůzka u notáře je naplánována na čtvrtek', classification: 'HARD DEADLINE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
    },
  },

  {
    id: 5,
    name: 'Signature address must NOT become meeting venue',
    sourceCommit: '0100e4f',
    latestInbound: 'Dobrý den, mám zájem o prohlídku bytu v Karlíně. Kdy by to šlo? S pozdravem, Marie Dvořáková\n\nRE/MAX Premium\nSokolovská 46/51, Praha 8\ntel: +420 777 123 456',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, mám zájem o prohlídku bytu v Karlíně. Kdy by to šlo? S pozdravem, Marie Dvořáková\n\nRE/MAX Premium\nSokolovská 46/51, Praha 8\ntel: +420 777 123 456', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Marie Dvořáková',
    channel: 'email',
    enrichment: {
      parties: ['Marie Dvořáková'],
      subject: 'Prohlídka bytu v Karlíně',
      messageType: 'meeting_request',
      coreIntent: 'Žádost o prohlídku bytu v Karlíně',
      addresses: ['Sokolovská 46/51, Praha 8'],
      proposedTimes: [],
      meetingType: 'prohlídka bytu',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      venue_index: null,
    },
  },

  {
    id: 6,
    name: 'missing_info must not interrogate — max 2 items',
    sourceCommit: '862e80a',
    latestInbound: 'Chtěl bych prodat byt. Můžeme se sejít?',
    recentMessages: [
      { direction: 'inbound', text: 'Chtěl bych prodat byt. Můžeme se sejít?', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Tomáš',
    channel: 'whatsapp',
    enrichment: {
      parties: ['Tomáš'],
      subject: 'Prodej bytu',
      messageType: 'meeting_request',
      coreIntent: 'Žádost o schůzku ohledně prodeje bytu',
      addresses: [],
      proposedTimes: [],
      meetingType: 'jednání',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      max_missing_info: 2,
    },
  },

  {
    id: 7,
    name: 'SCHEDULE = confirmation, not TODO',
    sourceCommit: 'b858a4f',
    latestInbound: 'Dobrý den, potvrzuji prohlídku zítra v 15:00 na adrese Vinohradská 25, Praha 2. Těším se, Karel',
    recentMessages: [
      { direction: 'outbound', text: 'Dobrý den pane Karle, nabízím vám prohlídku zítra v 15:00. Vyhovuje?', age: '1d ago' },
      { direction: 'inbound', text: 'Dobrý den, potvrzuji prohlídku zítra v 15:00 na adrese Vinohradská 25, Praha 2. Těším se, Karel', age: 'today' },
    ],
    summary: { currentState: 'Prohlídka domluvena', risks: [], nextSteps: ['Prohlídka'], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Karel',
    channel: 'email',
    enrichment: {
      parties: ['Karel'],
      subject: 'Potvrzení prohlídky',
      messageType: 'confirmation',
      coreIntent: 'Potvrzení prohlídky zítra v 15:00',
      addresses: ['Vinohradská 25, Praha 2'],
      proposedTimes: [{ original: 'zítra v 15:00', interpreted: 'zítra 15:00', relativeRef: 'tomorrow', timeOfDay: '15:00', eventContext: 'viewing' }],
      meetingType: 'prohlídka bytu',
      urgency: { quote: 'zítra v 15:00', classification: 'HARD DEADLINE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      venue_index: 0,
      time_index: 0,
    },
  },

  {
    id: 8,
    name: 'Draft must not fabricate — intent must reference real content',
    sourceCommit: '58abd9b',
    latestInbound: 'Dobrý den, posílám fotky z bytu. Dám vám vědět o dalších zájemcích. Martin',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, posílám fotky z bytu. Dám vám vědět o dalších zájemcích. Martin', age: 'today' },
    ],
    summary: { currentState: 'Čekáte na fotky a info o zájemcích', risks: [], nextSteps: [], keyPoints: [], confidence: 0.7, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Martin',
    channel: 'email',
    enrichment: {
      parties: ['Martin'],
      subject: 'Fotky z bytu',
      messageType: 'update',
      coreIntent: 'Zaslání fotek, info o dalších zájemcích',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      intent_not_contains: 'potvr',
      max_missing_info: 1,
    },
  },

  {
    id: 9,
    name: '"CP will send contract Monday" → revisit, not action',
    sourceCommit: '7081204',
    latestInbound: 'Dobrý den, smlouvu vám pošlu v pondělí. Hezký víkend, Petra',
    recentMessages: [
      { direction: 'outbound', text: 'Petro, mohla byste mi prosím poslat návrh smlouvy?', age: '2d ago' },
      { direction: 'inbound', text: 'Dobrý den, smlouvu vám pošlu v pondělí. Hezký víkend, Petra', age: 'today' },
    ],
    summary: { currentState: 'Čekáte na návrh smlouvy od Petry', risks: [], nextSteps: ['Petra pošle smlouvu v pondělí'], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Petra',
    channel: 'email',
    enrichment: {
      parties: ['Petra'],
      subject: 'Smlouva',
      messageType: 'update',
      coreIntent: 'Příslib zaslání smlouvy v pondělí',
      addresses: [],
      proposedTimes: [],
      urgency: { quote: 'smlouvu vám pošlu v pondělí', classification: 'SOFT REFERENCE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      no_action: true,
      has_revisit: true,
    },
  },

  {
    id: 10,
    name: 'Urgency must not be clamped to 2 for genuinely urgent message',
    sourceCommit: 'ba7473c',
    latestInbound: 'URGENTNÍ: Kupec chce podepsat dnes do 16:00, jinak odstupuje. Byt na Korunní 55, cena 8.5M. Potřebuji vaše potvrzení IHNED.',
    recentMessages: [
      { direction: 'inbound', text: 'URGENTNÍ: Kupec chce podepsat dnes do 16:00, jinak odstupuje. Byt na Korunní 55, cena 8.5M. Potřebuji vaše potvrzení IHNED.', age: 'today' },
    ],
    summary: { currentState: 'Urgentní podpis', risks: ['Kupec může odstoupit'], nextSteps: [], keyPoints: [], confidence: 0.9, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Broker',
    channel: 'email',
    enrichment: {
      parties: ['Broker'],
      subject: 'Urgentní podpis',
      coreIntent: 'Požadavek na okamžité potvrzení podpisu',
      addresses: ['Korunní 55'],
      proposedTimes: [],
      urgency: { quote: 'dnes do 16:00, jinak odstupuje', classification: 'HARD DEADLINE' },
      keyNumbers: { price: '8 500 000 Kč' },
    },
    journalText: '',
    assert: {
      needs_action: true,
      urgency_category: 'CRITICAL',
      type: 'REPLY',
    },
  },

  {
    id: 11,
    name: 'WhatsApp short message — valid SCHEDULE, not over-questioned',
    sourceCommit: '862e80a',
    latestInbound: 'Čau, zítra v 10 u toho bytu na Letný?',
    recentMessages: [
      { direction: 'inbound', text: 'Čau, zítra v 10 u toho bytu na Letný?', age: 'today' },
    ],
    summary: { currentState: 'Jednání o bytu na Letné', risks: [], nextSteps: [], keyPoints: [], confidence: 0.7, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Jakub',
    channel: 'whatsapp',
    enrichment: {
      parties: ['Jakub'],
      subject: 'Prohlídka bytu na Letné',
      messageType: 'meeting_request',
      coreIntent: 'Návrh prohlídky zítra v 10:00',
      addresses: [],
      proposedTimes: [{ original: 'zítra v 10', interpreted: 'zítra 10:00', relativeRef: 'tomorrow', timeOfDay: '10:00', eventContext: 'viewing' }],
      meetingType: 'prohlídka bytu',
      urgency: { quote: 'zítra v 10', classification: 'HARD DEADLINE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      time_index: 0,
      venue_index: null,
      max_missing_info: 2,
    },
  },

  {
    id: 12,
    name: 'Newsletter/automated email must not produce action',
    sourceCommit: '7081204',
    latestInbound: 'Nové nemovitosti v Praze tento týden: 3+kk Vinohrady 6.2M, 2+1 Žižkov 4.1M, 4+kk Dejvice 12.5M. Odhlásit se z newsletteru.',
    recentMessages: [
      { direction: 'inbound', text: 'Nové nemovitosti v Praze tento týden: 3+kk Vinohrady 6.2M, 2+1 Žižkov 4.1M, 4+kk Dejvice 12.5M. Odhlásit se z newsletteru.', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'Reality Portal',
    channel: 'email',
    enrichment: {
      parties: ['Reality Portal'],
      subject: 'Nové nemovitosti',
      messageType: 'newsletter',
      coreIntent: 'Týdenní přehled nových nemovitostí',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      no_action: true,
    },
  },

  {
    id: 13,
    name: 'REPLY vs TODO — question needs REPLY, not TODO',
    sourceCommit: '715dd01',
    latestInbound: 'Dobrý den, jaká je vaše představa o ceně za byt na Praze 5? Máme klienta se zájmem. Díky, Lenka',
    recentMessages: [
      { direction: 'inbound', text: 'Dobrý den, jaká je vaše představa o ceně za byt na Praze 5? Máme klienta se zájmem. Díky, Lenka', age: 'today' },
    ],
    summary: { currentState: 'Poptávka na byt na Praze 5', risks: [], nextSteps: [], keyPoints: [], confidence: 0.7, confidenceReason: '', dealType: 'sale' },
    pendingActions: [],
    cpName: 'Lenka',
    channel: 'email',
    enrichment: {
      parties: ['Lenka'],
      subject: 'Cenová představa',
      messageType: 'question',
      coreIntent: 'Dotaz na cenovou představu za byt na Praze 5',
      addresses: [],
      proposedTimes: [],
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'REPLY',
    },
  },

  {
    id: 14,
    name: 'Already-pending action should not be duplicated',
    sourceCommit: '7081204',
    latestInbound: 'Tak co, domluvíme tu prohlídku? Odpovězte prosím.',
    recentMessages: [
      { direction: 'inbound', text: 'Chtěl bych se podívat na ten byt. Můžeme domluvit prohlídku?', age: '2d ago' },
      { direction: 'inbound', text: 'Tak co, domluvíme tu prohlídku? Odpovězte prosím.', age: 'today' },
    ],
    summary: { currentState: 'CP čeká na domluvení prohlídky', risks: ['CP se opakovaně ptá'], nextSteps: ['Domluvit prohlídku'], keyPoints: [], confidence: 0.8, confidenceReason: '', dealType: 'sale' },
    pendingActions: [{ type: 'SCHEDULE', intent: 'Domluvit prohlídku bytu', urgency: 5 }],
    cpName: 'Ondřej',
    channel: 'email',
    enrichment: {
      parties: ['Ondřej'],
      subject: 'Prohlídka bytu',
      messageType: 'follow_up',
      coreIntent: 'Opakovaná žádost o domluvení prohlídky',
      addresses: [],
      proposedTimes: [],
      urgency: { quote: 'Odpovězte prosím', classification: 'SOFT REFERENCE' },
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      no_action: true,
    },
  },

  {
    id: 15,
    name: 'Online meeting must not require address',
    sourceCommit: '0100e4f',
    latestInbound: 'Můžeme to probrat přes videohovor? Zítra odpoledne by mi vyhovovalo. Pošlu vám link na Teams.',
    recentMessages: [
      { direction: 'inbound', text: 'Můžeme to probrat přes videohovor? Zítra odpoledne by mi vyhovovalo. Pošlu vám link na Teams.', age: 'today' },
    ],
    summary: null,
    pendingActions: [],
    cpName: 'David',
    channel: 'email',
    enrichment: {
      parties: ['David'],
      subject: 'Videohovor',
      messageType: 'meeting_request',
      coreIntent: 'Návrh videohovoru zítra odpoledne',
      addresses: [],
      proposedTimes: [{ original: 'zítra odpoledne', interpreted: 'zítra odpoledne', relativeRef: 'tomorrow', eventContext: 'online_meeting' }],
      meetingType: 'online meeting',
      urgency: null,
      keyNumbers: {},
    },
    journalText: '',
    assert: {
      needs_action: true,
      type: 'SCHEDULE',
      venue_index: null,
      time_index: 0,
    },
  },
]

// ─── Runner ────────────────────────────────────────────────────────────────

interface CaseResult {
  id: number
  name: string
  pass: boolean
  failures: string[]
  raw?: Record<string, unknown>
}

async function runCase(tc: EvalCase): Promise<CaseResult> {
  const failures: string[] = []

  try {
    const result = await triageConversation(
      tc.latestInbound,
      tc.recentMessages,
      tc.summary,
      tc.pendingActions,
      tc.cpName,
      tc.channel,
      TEST_SETTINGS,
      tc.journalText,
      tc.enrichment,
    )

    const a = tc.assert

    if (a.no_action === true && result.needs_action) {
      failures.push(`Expected no action, got needs_action=true (type=${result.action?.type})`)
    }

    if (a.needs_action === true && !result.needs_action) {
      failures.push(`Expected needs_action=true, got false`)
    }

    if (a.has_revisit === true && !result.revisit_at) {
      failures.push(`Expected revisit_at to be set, got null`)
    }

    if (result.needs_action && result.action) {
      const action = result.action

      if (a.type && action.type !== a.type) {
        failures.push(`Expected type=${a.type}, got ${action.type}`)
      }

      if (a.urgency_category && action.urgency_category !== a.urgency_category) {
        failures.push(`Expected urgency_category=${a.urgency_category}, got ${action.urgency_category}`)
      }

      if (a.venue_index !== undefined && action.venue_index !== a.venue_index) {
        failures.push(`Expected venue_index=${a.venue_index}, got ${action.venue_index}`)
      }

      if (a.time_index !== undefined && action.time_index !== a.time_index) {
        failures.push(`Expected time_index=${a.time_index}, got ${action.time_index}`)
      }

      if (a.intent_contains && !action.intent_cs.toLowerCase().includes(a.intent_contains.toLowerCase())) {
        failures.push(`Expected intent_cs to contain "${a.intent_contains}", got "${action.intent_cs}"`)
      }

      if (a.intent_not_contains && action.intent_cs.toLowerCase().includes(a.intent_not_contains.toLowerCase())) {
        failures.push(`Expected intent_cs to NOT contain "${a.intent_not_contains}", got "${action.intent_cs}"`)
      }

      if (a.max_missing_info !== undefined && (action.missing_info?.length || 0) > a.max_missing_info) {
        failures.push(`Expected max ${a.max_missing_info} missing_info items, got ${action.missing_info?.length || 0}`)
      }
    }

    return {
      id: tc.id,
      name: tc.name,
      pass: failures.length === 0,
      failures,
      raw: result as unknown as Record<string, unknown>,
    }
  } catch (err) {
    return {
      id: tc.id,
      name: tc.name,
      pass: false,
      failures: [`THREW: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const caseFlag = args.indexOf('--case')
  const singleCase = caseFlag >= 0 ? parseInt(args[caseFlag + 1], 10) : null

  const cases = singleCase
    ? EVAL_CASES.filter(c => c.id === singleCase)
    : EVAL_CASES

  if (cases.length === 0) {
    console.error(`No test case with id=${singleCase}`)
    process.exit(1)
  }

  if (!jsonMode) {
    console.log(`\nRunning ${cases.length} triage eval cases...\n`)
  }

  const results: CaseResult[] = []

  // Run sequentially to avoid rate limits
  for (const tc of cases) {
    if (!jsonMode) process.stdout.write(`  #${tc.id} ${tc.name}... `)
    const result = await runCase(tc)
    results.push(result)
    if (!jsonMode) {
      if (result.pass) {
        console.log('PASS')
      } else {
        console.log('FAIL')
        for (const f of result.failures) console.log(`    - ${f}`)
      }
    }
  }

  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length

  if (jsonMode) {
    console.log(JSON.stringify({ passed, failed, total: results.length, results }, null, 2))
  } else {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Results: ${passed}/${results.length} passed, ${failed} failed`)
    console.log(`Pass rate: ${Math.round((passed / results.length) * 100)}%`)
    if (failed > 0) {
      console.log(`\nFailed cases:`)
      for (const r of results.filter(r => !r.pass)) {
        console.log(`  #${r.id}: ${r.name}`)
        for (const f of r.failures) console.log(`    - ${f}`)
      }
    }
    console.log()
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Eval harness error:', err)
  process.exit(1)
})
