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
 *   --cleanup-only    (removed — cleanup never worked reliably)
 *   --prod            Use production URL (https://mila.specialagents.pro)
 *   --quick           Quick smoke test — 1 email, 1 agent run, basic checks (~30s)
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import * as readline from 'readline'
import { google, gmail_v1 } from 'googleapis'
import { getAuthenticatedClient } from '../src/lib/google/auth'
import { generateActionToken } from '../src/lib/auth/tokens'

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
// Full back-and-forth about office space at Sokolovská, Karlín.
// Settled at 450 CZK/m2, 3yr with renewal option.
// User replies use direction: 'outbound' — injected with SENT label, ingested as outbound.

const EVA_EMAIL = 'ainikpage+dvorakova.eva@gmail.com'
const EVA_FROM = 'Eva Dvorakova <ainikpage+dvorakova.eva@gmail.com>'
// USER_EMAIL is resolved at runtime from Gmail profile

const EVA_NEGOTIATION_SUBJECT = `[${RUN_ID}] Karlin office space — Sokolovská`

const EVA_NEGOTIATION_HISTORY: Omit<HistoryEmail, 'to'>[] = [
  // 1. Eva's initial inquiry — friendly, enthusiastic about the listing
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: EVA_NEGOTIATION_SUBJECT,
    daysAgo: 28,
    body: [
      'Ahoj!',
      '',
      'Narazila jsem na váš inzerát kancelářských prostor v Karlíně na Sokolovské',
      'a úplně mě to nadchlo — přesně tohle hledáme pro Dvorak & Partners.',
      'Potřebujeme cca 200m2, ideálně open plan s pár zasedačkami.',
      '',
      'Mohli byste nám poslat podrobnosti? Půdorys, cena za m2, podmínky nájmu...',
      'Ráda bych to viděla co nejdřív, Karlín je naše vysněná lokalita :)',
      '',
      'Díky moc,',
      'Eva Dvořáková',
      'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  // 2. User sends floor plan and pricing
  {
    cpKey: 'eva',
    direction: 'outbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 27,
    body: [
      'Dobrý den Evo,',
      '',
      'díky za zájem! Posílám podklady:',
      '- Půdorys třetího patra (Sokolovská 46/51, Praha 8): 200m2 open plan, 2 zasedačky, kuchyňka',
      '- Cena: 465 CZK/m2/měsíc, standardní nájemní podmínky (3 nebo 5 let)',
      '- Budova je po kompletní rekonstrukci, nová klimatizace + výtah',
      '',
      'Ohledně prohlídky — jsem k dispozici ve středu nebo ve čtvrtek odpoledne.',
      'Dejte vědět, co vám víc vyhovuje.',
      '',
      's pozdravem',
    ].join('\n'),
  },
  // 3. Eva responds — counteroffers at 420 CZK/m2, wants to view
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 24,
    body: [
      'Super, díky za ty podklady! Půdorys třetího patra vypadá skvěle.',
      'Sokolovská 46/51, Praha 8, 200m2 open plan se 2 zasedačkami —',
      'přesně si to představuju.',
      '',
      'Jediný háček — 465 CZK/m2 je trošku nad náš rozpočet.',
      'Co kdybychom nabídli 420 CZK/m2/měsíc s desetiletým závazkem?',
      'Víte, delší nájem = jistota pro obě strany, a to by snad ospravedlnilo nižší sazbu.',
      '',
      'A hlavně — můžeme si prostory prohlédnout tento týden? Moc se těším!',
      '',
      'Eva',
      'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  // 4. User confirms viewing time, holds on price
  {
    cpKey: 'eva',
    direction: 'outbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 23,
    body: [
      'Evo,',
      '',
      'prohlídka v pořádku — čtvrtek ve 14h funguje. Uvidíme se přímo',
      'na místě, Sokolovská 46/51, třetí patro.',
      '',
      'K ceně: 420 na 10 let je zajímavé, ale potřebuju to probrat se',
      'spolumajitelem. Základ bude 465, ale uvidíme co vymyslíme.',
    ].join('\n'),
  },
  // 5. Eva after the viewing — loved it, holds her 420 offer
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 20,
    body: [
      'Ahoj,',
      '',
      'Ještě jednou díky za včerejší prohlídku — ta kancelář je fakt super.',
      'Ten výhled z třetího patra! Kolegové byli úplně nadšení.',
      '',
      'Chápu vaši pozici ohledně 465 CZK/m2, přemýšlím o tom.',
      'Ale upřímně, 420 na 10 let je taky férová nabídka —',
      'celkem je to 10,08M Kč garantovaného příjmu. To není málo :)',
      '',
      'Dejte nám vědět do konce týdne? Nechci tlačit, jen ať máme jasno.',
      '',
      'Eva',
    ].join('\n'),
  },
  // 6. User counters: 450 CZK/m2 for 3 years + renewal option
  {
    cpKey: 'eva',
    direction: 'outbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 18,
    body: [
      'Evo,',
      '',
      'mluvil jsem se spolumajitelem. Tady je naše protinabídka:',
      '450 CZK/m2/měsíc na 3 roky s opcí na prodloužení za tržní cenu platnou ke dni prodloužení.',
      '',
      'Kratší závazek pro vás, ale opce vám dá jistotu do budoucna.',
      'Myslím, že je to fér kompromis pro obě strany.',
      '',
      'Dejte vědět do středy?',
    ].join('\n'),
  },
  // 7. Eva proposes middle ground: 440/m2 on 5 years
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 14,
    body: [
      'Ahoj,',
      '',
      'Díky za trpělivost s námi! Vaše protinabídka je férová — 450 CZK/m2,',
      'jen mě trochu mrzí ty 3 roky. Pro nás je to krátký závazek za tu cenu.',
      '',
      'Co takhle kompromis: 440 CZK/m2 na 5 let?',
      'Obě strany mají jistotu a je to blíž vaší představě než těch 420 na 10.',
      '',
      'Abych byla upřímná — koukáme ještě na prostory na Bubenské,',
      'ale Sokolovská se nám líbí mnohem víc. Tak snad se domluvíme!',
      '',
      'Eva',
      'Dvorak & Partners s.r.o.',
    ].join('\n'),
  },
  // 8. User holds firm: 450/3yr is the final offer
  {
    cpKey: 'eva',
    direction: 'outbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 13,
    body: [
      'Evo,',
      '',
      '450 CZK/m2 na 3 roky s opcí je naše finální nabídka — níže nejdeme.',
      'Ta opce vám zaručí předkupní právo za tržní cenu, takže v praxi',
      'máte jistotu na mnohem déle než 3 roky.',
      '',
      'Bubenská je Smíchov — jiná lokalita, jiný klientský segment.',
      'Sokolovská vás postaví do středu Karlína. Záleží na tom, jak se chcete prezentovat.',
      '',
      'Čekám na vaše rozhodnutí.',
    ].join('\n'),
  },
  // 9. Eva accepts — 450/m2 for 3 years, wants to sign ASAP
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 9,
    body: [
      'Ahoj!',
      '',
      'Mám skvělou zprávu — probrala jsem vaši finální nabídku s vedením:',
      '450 CZK/m2/měsíc na 3 roky s opcí na prodloužení za tržní cenu.',
      '',
      'Souhlasíme! Ta opce na prodloužení nám dává klid, takže jsme spokojení.',
      '',
      'Kdy bychom mohli domluvit podpis? Potřebujeme se nastěhovat',
      'do poloviny dubna — ideálně bych chtěla mít smlouvu hotovou co nejdřív.',
      '',
      'A díky za trpělivost při tom vyjednávání — vím, že to chvíli trvalo,',
      'ale mám radost, že jsme se domluvili :)',
      '',
      'Eva',
    ].join('\n'),
  },
  // 10. User acknowledges, sends draft contract to lawyer
  {
    cpKey: 'eva',
    direction: 'outbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 8,
    body: [
      'Evo, výborně!',
      '',
      'Pošlu dnes odpoledne návrh nájemní smlouvy na váš právní tým.',
      'Počítám s nástupem 15. dubna — potřebujeme podpisy nejpozději do 10. dubna.',
      '',
      'Dejte mi vědět jakmile právník projde dokument a bude mít připomínky.',
    ].join('\n'),
  },
  // 11. Eva: lawyer reviewed, 2 issues: notice period + parking
  {
    cpKey: 'eva',
    direction: 'inbound',
    from: EVA_FROM,
    subject: `Re: ${EVA_NEGOTIATION_SUBJECT}`,
    daysAgo: 5,
    body: [
      'Ahoj,',
      '',
      'Náš právník prošel návrh smlouvy — říká, že je to v pohodě,',
      'jen má dvě drobné připomínky:',
      '1) Výpovědní lhůta — chtěli bychom 6 měsíců místo 3 (prostě pro jistotu)',
      '2) Parkování — potřebujeme potvrdit 3 místa v garážích pro naše lidi',
      '',
      'Jinak jsme připravení podepsat! Už se těšíme na stěhování :)',
      'Dejte vědět, kdy to můžeme uzavřít.',
      '',
      'Eva',
      'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
]

// ─── Novotný Negotiation History (Thread 2: Difficult commercial sale) ───────
// Full back-and-forth over 45M commercial building in Vinohrady.
// Novotný is aggressive — pushes back on price, changes terms, creates pressure.
// User replies use direction: 'outbound' — injected with SENT label.

const NOVOTNY_EMAIL = 'ainikpage+novotny.jan@gmail.com'
const NOVOTNY_FROM = 'Jan Novotny <ainikpage+novotny.jan@gmail.com>'

const NOVOTNY_NEGOTIATION_SUBJECT = `[${RUN_ID}] Komerční budova Vinohrady — nabídka`

const NOVOTNY_NEGOTIATION_HISTORY: Omit<HistoryEmail, 'to'>[] = [
  // 1. Novotný's initial inquiry — representing a buyer
  {
    cpKey: 'urgent',
    direction: 'inbound',
    from: NOVOTNY_FROM,
    subject: NOVOTNY_NEGOTIATION_SUBJECT,
    daysAgo: 35,
    body: [
      'Dobrý den,',
      '',
      'Jan Novotný z Prague Commercial. Mám klienta, který hledá',
      'komerční nemovitost v Praze 2 — viděli jsme vaši budovu na Vinohradech.',
      '',
      'Můžete nám poslat podrobnosti? Zajímá nás celková užitná plocha,',
      'stav budovy, aktuální obsazenost a požadovaná cena.',
      '',
      'Klient má rozpočet kolem 40M Kč a může uzavřít rychle.',
      '',
      'Jan Novotný',
      'Senior Broker, Prague Commercial',
      'Třinecká 672, Praha',
    ].join('\n'),
  },
  // 2. User sends property details
  {
    cpKey: 'urgent',
    direction: 'outbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 34,
    body: [
      'Dobrý den pane Novotný,',
      '',
      'posílám základní informace k budově na Vinohradech:',
      '- Celková užitná plocha: 1 200 m2 (6 podlaží)',
      '- Obsazenost: 85% (10 z 12 jednotek pronajato)',
      '- Průměrný výnos z nájmů: 180 000 Kč/měsíc',
      '- Stav: dobrý, fasáda plánována na příští rok',
      '- Požadovaná cena: 48 000 000 Kč',
      '',
      'Výtah je aktuálně v revizi — dokončení do konce měsíce.',
      'Budova je v centru Prahy 2, vynikající lokalita pro investici.',
      '',
      'Rád domluvím prohlídku pro vašeho klienta.',
      's pozdravem',
    ].join('\n'),
  },
  // 3. Novotný lowballs at 38M
  {
    cpKey: 'urgent',
    direction: 'inbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 30,
    body: [
      'Díky za podklady. 1200m2, 85% obsazenost, to vypadá dobře.',
      '',
      'Ale 48M je příliš. Budova potřebuje novou fasádu a výtah neprošel',
      'poslední revizí — to jsou náklady kolem 3-4M pro kupujícího.',
      '',
      'Nabízíme 38M Kč s uzavřením do 60 dnů.',
      'Klient má připravené financování od Komerční banky.',
      '',
      'Dejte mi vědět do pátku — klient se dívá ještě na Žižkov.',
      '',
      'Jan Novotný',
      'Prague Commercial',
    ].join('\n'),
  },
  // 4. User counters at 45M — explains value
  {
    cpKey: 'urgent',
    direction: 'outbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 29,
    body: [
      'Pane Novotný,',
      '',
      '38M je hluboko pod tržní cenou pro tuto lokalitu.',
      '',
      'Fakta: nájemní výnos 2,16M Kč ročně = hrubý yield 4,5% při 48M.',
      'Srovnatelné budovy v Praze 2 se prodávají za 42-50M.',
      'Fasáda je kozmetická záležitost — výtah bude revizí do konce měsíce.',
      '',
      'Přistoupím na 45 000 000 Kč — finální cena, žádné další slevy.',
      'Due diligence samozřejmě možné, přístup k budově domluvíme.',
      '',
      'Žižkov není Praha 2. Vaší klient ví proč hledá na Vinohradech.',
    ].join('\n'),
  },
  // 5. Novotný pushes back — 41M + conditions
  {
    cpKey: 'urgent',
    direction: 'inbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 24,
    body: [
      'Chápu vaše argumenty ohledně lokality a výnosu z nájmů,',
      'ale 45M je stále nad tržní cenou pro budovy v tomto stavu.',
      '',
      'Můj klient je ochoten nabídnout 41M Kč, ale pod podmínkou:',
      '- Prodávající opraví výtah před uzavřením (odhad 800k Kč)',
      '- Uzavření do 45 dnů od podpisu kupní smlouvy',
      '- Přístup k budově pro due diligence tento týden',
      '',
      'Na Žižkově máme srovnatelnou budovu za 39M v lepším stavu.',
      'Dejte nám odpověď do středy.',
      '',
      'Novotný',
    ].join('\n'),
  },
  // 6. User grants due diligence access, holds at 45M
  {
    cpKey: 'urgent',
    direction: 'outbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 23,
    body: [
      'Pane Novotný,',
      '',
      'due diligence povolím — kontaktujte správce budovy (tel. 602 xxx xxx)',
      'a domluvte se na přístupu ve středu nebo ve čtvrtek.',
      '',
      'Oprava výtahu proběhne — ale cena zůstává 45M.',
      '41M nepřijmu. Budova generuje ověřitelný výnos a lokalita to ospravedlňuje.',
      '',
      'Pokud váš klient Žižkov preferuje, ať jde na Žižkov.',
    ].join('\n'),
  },
  // 7. Novotný after due diligence — found issues, leverages them
  {
    cpKey: 'urgent',
    direction: 'inbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 18,
    body: [
      'Provedli jsme due diligence na Vinohradech. Pár zjištění:',
      '',
      '- Elektroinstalace v přízemí neodpovídá normám — bude potřeba',
      '  revize před jakýmkoli pronájmem nových prostor',
      '- Dva nájemci mají smlouvu končící za 4 měsíce a nechtějí prodloužit',
      '- Parkoviště nemá kolaudaci pro komerční využití',
      '',
      'S ohledem na tyto skutečnosti navrhuji upravit naši nabídku:',
      '42M Kč s tím, že prodávající vyřeší elektroinstalaci.',
      'Pokud ne — 40M as-is.',
      '',
      'Souhlasím s vaší podmínkou ohledně opravy výtahu — je to',
      'rozumný kompromis. Ale ta elektřina je zásadní.',
      '',
      'Jan Novotný',
      'Prague Commercial',
    ].join('\n'),
  },
  // 8. User addresses issues, holds at 45M
  {
    cpKey: 'urgent',
    direction: 'outbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 17,
    body: [
      'Pane Novotný,',
      '',
      'k elektroinstalaci: nechám udělat odborný posudek. Pokud bude',
      'potřeba revize, náklady si rozdělíme 50/50 — to je rozumný kompromis.',
      '',
      'Nájemci s končící smlouvou: to je standardní situace pro každou budovu.',
      'Zbývajících 8 nájemců má smlouvy na 2-5 let. Výnos je stabilní.',
      '',
      'Parkoviště: kolaudace pro komerční využití vyřídím do uzavření.',
      '',
      'Cena: 45M. Finálně. Nepohnu se z toho.',
    ].join('\n'),
  },
  // 9. Novotný escalates to 43.5M, creates deadline
  {
    cpKey: 'urgent',
    direction: 'inbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 12,
    body: [
      'Tak dobře. Mluvil jsem s klientem a je ochoten jít na 43,5M.',
      'To je naše absolutní maximum.',
      '',
      'Nicméně mám podmínku — musíme uzavřít rychle.',
      'Klient zvažuje budovu na Žižkově za 39M a potřebuje',
      'se rozhodnout do konce příštího týdne.',
      '',
      'Pokud přistoupíte na 43,5M, můžeme mít podepsanou smlouvu',
      'u notáře do 10 dnů. Financování je schváleno, banka čeká',
      'jen na finální kupní smlouvu.',
      '',
      'Jinak se obávám, že klient půjde jinam. Nechci vás tlačit,',
      'ale tohle je realita trhu.',
      '',
      'Jan Novotný',
      'Senior Broker, Prague Commercial',
      'Třinecká 672, Praha',
    ].join('\n'),
  },
  // 10. User holds firm: 45M or nothing
  {
    cpKey: 'urgent',
    direction: 'outbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 11,
    body: [
      'Pane Novotný,',
      '',
      '45M nebo ne. Žádná jiná varianta neexistuje.',
      '',
      'Vaší klient má schválené financování — 1,5M Kč navíc při ceně 45M',
      'je přesně ta marže, kvůli které se vyplatí mít schválenou hypotéku.',
      '',
      'Pokud jde na Žižkov, jde na Žižkov. Budovu prodám jinému zájemci.',
    ].join('\n'),
  },
  // 11. Novotný: buyer relents, agrees to 45M, wants docs
  {
    cpKey: 'urgent',
    direction: 'inbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 7,
    body: [
      'Dobrý den,',
      '',
      'Klient souhlasí s 45M Kč — vaše argumenty ohledně lokality',
      'a stabilních nájemců ho přesvědčily. Žižkov nakonec odpadl.',
      '',
      'Můj právník připraví návrh kupní smlouvy do pondělí.',
      'Potřebuji od vás:',
      '1) Aktuální list vlastnictví (ne starší než 3 dny)',
      '2) Potvrzení o bezdlužnosti SVJ',
      '3) Energetický průkaz budovy',
      '',
      'Navrhuji notáře JUDr. Procházku na Třinecké 672 —',
      'spolupracuji s ním pravidelně a je k dispozici příští týden.',
      '',
      'Domluvíme přesný termín, jakmile budeme mít smlouvu.',
      '',
      'Jan Novotný',
      'Prague Commercial',
      'Třinecká 672, Praha',
    ].join('\n'),
  },
  // 12. User confirms, says docs are coming
  {
    cpKey: 'urgent',
    direction: 'outbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 6,
    body: [
      'Pane Novotný,',
      '',
      'výborně. Připravuji dokumenty:',
      '- List vlastnictví: objednám na katastru dnes, hotový do 2 dnů',
      '- Bezdlužnost SVJ: čekám na správce, slíbil do pátku',
      '- Energetický průkaz: mám, pošlu v příloze',
      '',
      'JUDr. Procházka na Třinecké 672 mi vyhovuje.',
      'Navrhuju termín příští týden ve čtvrtek nebo pátek — potvrdím jakmile',
      'budu mít kompletní dokumenty.',
    ].join('\n'),
  },
  // 13. Novotný: buyer impatient, deadline pressure, wants docs today
  {
    cpKey: 'urgent',
    direction: 'inbound',
    from: NOVOTNY_FROM,
    subject: `Re: ${NOVOTNY_NEGOTIATION_SUBJECT}`,
    daysAgo: 3,
    body: [
      'Potřebuji ty dokumenty co nejdřív — kupující tlačí.',
      '',
      'List vlastnictví a bezdlužnost SVJ jste slíbil poslat včera.',
      'Právník má smlouvu hotovou a čeká jen na to.',
      '',
      'Klient má další nemovitost v záloze a začíná být nervózní',
      'z prodlení. Pokud nepodepíšeme do konce týdne,',
      'nemůžu garantovat, že nabídka 45M bude stále na stole.',
      '',
      'Prosím, pošlete dokumenty DNES.',
      '',
      'Novotný',
    ].join('\n'),
  },
]

// ─── Klára Marcinová History (Thread 3: Cooling lead — user waiting, CP silent) ─
// Buyer interested in a villa in Dejvice, Prague 6. Budget ~9.5M CZK.
// There were several productive exchanges 3 weeks ago (viewing, liked it, price discussion).
// User sent a follow-up 11 days ago confirming second viewing availability.
// Klára never replied. → cooling lead, Mila should prompt user to follow up.

const KLARA_EMAIL = 'ainikpage+KlaraMarcinova@gmail.com'
const KLARA_FROM = 'Klara Marcinova <ainikpage+KlaraMarcinova@gmail.com>'

const KLARA_NEGOTIATION_SUBJECT = `[${RUN_ID}] Vila Dejvice — Antonínská 12`

const KLARA_NEGOTIATION_HISTORY: Omit<HistoryEmail, 'to'>[] = [
  // 1. Klára's first contact — saw the listing, wants details
  {
    cpKey: 'klara',
    direction: 'inbound',
    from: KLARA_FROM,
    subject: KLARA_NEGOTIATION_SUBJECT,
    daysAgo: 24,
    body: [
      'Dobrý den,',
      '',
      'narazila jsem na váš inzerát vily na Antonínské 12 v Dejvicích.',
      'Hledáme rodinný dům v Praze 6 — manžel pracuje v Bubenči a já',
      'pracuju v centru, takže Dejvice jsou pro nás ideální.',
      '',
      'Mohli byste mi poslat více informací? Zajímá nás dispozice,',
      'stav zahrady, možnost parkování a přesná cena.',
      '',
      'S pozdravem,',
      'Klára Marcinová',
    ].join('\n'),
  },
  // 2. User replies with property details, proposes viewing
  {
    cpKey: 'klara',
    direction: 'outbound',
    from: KLARA_FROM,
    subject: `Re: ${KLARA_NEGOTIATION_SUBJECT}`,
    daysAgo: 23,
    body: [
      'Dobrý den paní Marcinová,',
      '',
      'děkuji za zájem! Posílám detaily k vile na Antonínské 12:',
      '- Dispozice: 5+1, 280 m2 užitné plochy, pozemek 650 m2',
      '- Zahrada: udržovaná, terasa, pergola, garáž pro 2 auta',
      '- Stav: po rekonstrukci 2021 (kuchyně, koupelny, podlahy)',
      '- Cena: 9 800 000 Kč',
      '',
      'Dejvice, klidná ulice 5 minut pěšky od metra Hradčanská.',
      '',
      'Rád domluvím prohlídku — jsem k dispozici příští týden.',
      's pozdravem',
    ].join('\n'),
  },
  // 3. Klára asks follow-up questions, wants viewing next week
  {
    cpKey: 'klara',
    direction: 'inbound',
    from: KLARA_FROM,
    subject: `Re: ${KLARA_NEGOTIATION_SUBJECT}`,
    daysAgo: 21,
    body: [
      'Dobrý den,',
      '',
      'to zní skvěle! Pár doplňujících otázek:',
      '- Jsou v ceně také veškeré spotřebiče?',
      '- Jak stará je střecha?',
      '- Je možné se nastěhovat do konce června?',
      '',
      'Prohlídka: mohlo by to být v úterý nebo ve středu odpoledne?',
      'Nejlépe kolem 16h, manžel by šel se mnou.',
      '',
      'Klára',
    ].join('\n'),
  },
  // 4. User answers questions, confirms viewing time
  {
    cpKey: 'klara',
    direction: 'outbound',
    from: KLARA_FROM,
    subject: `Re: ${KLARA_NEGOTIATION_SUBJECT}`,
    daysAgo: 20,
    body: [
      'Paní Marcinová,',
      '',
      'spotřebiče: ano, vše v ceně (Bosch kuchyně, myčka, lednička).',
      'Střecha: 2019, v perfektním stavu, pojistka do 2029.',
      'Nastěhování do konce června: určitě možné, ideální timing.',
      '',
      'Prohlídka: středa ve 16h mi vyhovuje. Adresa Antonínská 12, Praha 6 —',
      'zaparkovat lze přímo u domu nebo v přilehlé ulici.',
      '',
      'Těším se na setkání.',
    ].join('\n'),
  },
  // 5. Klára after the viewing — enthusiastic, considering, mentions price
  {
    cpKey: 'klara',
    direction: 'inbound',
    from: KLARA_FROM,
    subject: `Re: ${KLARA_NEGOTIATION_SUBJECT}`,
    daysAgo: 17,
    body: [
      'Dobrý den,',
      '',
      'díky za prohlídku — vila je krásná, manžel i já jsme si to oblíbili.',
      'Ta zahrada a garáž jsou přesně to, co hledáme.',
      '',
      'Jediné co nás trošku zarazilo — cena. 9,8M je na hraně našeho rozpočtu.',
      'Je prostor pro vyjednávání? Třeba 9,3-9,4M?',
      '',
      'Jinak bychom velmi rádi šli dál. Ještě bychom chtěli jednou projet',
      's rodiči, kteří nám pomáhají s financováním.',
      '',
      'Klára',
    ].join('\n'),
  },
  // 6. User responds to price question, invites second viewing
  {
    cpKey: 'klara',
    direction: 'outbound',
    from: KLARA_FROM,
    subject: `Re: ${KLARA_NEGOTIATION_SUBJECT}`,
    daysAgo: 11,
    body: [
      'Paní Marcinová,',
      '',
      'rád, že se vila líbila! K ceně: 9,5M Kč je můj konečný limit —',
      'pod to nejdu, ale to snížení od 9,8M je pro vás 300 000 Kč navíc.',
      '',
      'Druhá prohlídka s rodiči je samozřejmě vítaná.',
      'Dám vám vědět o dalších zájemcích, pokud by se situace změnila.',
      '',
      'Kdy by rodiče mohli přijet? Jsem k dispozici tento nebo příští týden.',
    ].join('\n'),
  },
  // Klára never replied. This is the last message — user is now waiting.
]

// ─── Tomáš Horák History (Thread 4: Buyer goes on vacation → snooze trigger) ──
// Short exchange about a garden flat in Košíře. Tomáš is interested but leaving
// for 3-week vacation. His "current" email says "ozveme se po návratu" — triage
// should set revisit_at (~May 5), lead tracking should skip this conversation.

const TOMAS_EMAIL = 'ainikpage+horak.tomas@gmail.com'
const TOMAS_FROM = 'Tomas Horak <ainikpage+horak.tomas@gmail.com>'

const TOMAS_SUBJECT = `[${RUN_ID}] Zahradní byt Košíře — Na Popelce`

const TOMAS_HISTORY: Omit<HistoryEmail, 'to'>[] = [
  // 1. Tomáš sees listing, asks for details
  {
    cpKey: 'tomas',
    direction: 'inbound',
    from: TOMAS_FROM,
    subject: TOMAS_SUBJECT,
    daysAgo: 8,
    body: [
      'Dobrý den,',
      '',
      'viděl jsem váš inzerát na zahradní byt Na Popelce v Košířích.',
      'Hledáme s partnerkou byt se zahrádkou v Praze 5 — máme rozpočet kolem 6,5M.',
      '',
      'Je byt stále k dispozici? Mohli bychom ho vidět tento týden?',
      '',
      'Díky,',
      'Tomáš Horák',
    ].join('\n'),
  },
  // 2. User responds with details
  {
    cpKey: 'tomas',
    direction: 'outbound',
    from: TOMAS_FROM,
    subject: `Re: ${TOMAS_SUBJECT}`,
    daysAgo: 7,
    body: [
      'Dobrý den pane Horáku,',
      '',
      'byt je k dispozici — 3+kk, 78m2, zahrada 45m2, cena 6 900 000 Kč.',
      'Po rekonstrukci 2023, klidná ulice.',
      '',
      'Prohlídku můžeme domluvit na čtvrtek nebo pátek odpoledne.',
      'Dejte vědět, co vám vyhovuje.',
    ].join('\n'),
  },
]

// ─── JUDr. Krejčí — Service CP (lawyer handling Novotný purchase) ─────────
// Single email from a lawyer. Lead tracking should detect service role and
// never flag this conversation as cooling/cold. Triage may still propose
// a REPLY or TODO (lawyer asked for documents) — that's expected.

const KREJCI_EMAIL = 'ainikpage+krejci.martin@gmail.com'
const KREJCI_FROM = 'JUDr. Martin Krejci <ainikpage+krejci.martin@gmail.com>'

// ─── Self-Email Command ────────────────────────────────────────────────────
// User emails themselves with "Mila:" prefix → intercepted in ingestion
// pipeline → AI-parsed → creates new CP. Trace: cps table has "Petr Svoboda".

const SELF_EMAIL_COMMAND = {
  subject: `[${RUN_ID}] Mila: nový kontakt`,
  body: [
    'Petr Svoboda',
    'Tel: 602 555 123',
    'Email: petr.svoboda@remax.cz',
    'Role: buyer',
    'Hledá byt v Praze 3, rozpočet 4-5M',
  ].join('\n'),
}

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
      'Ahoj!',
      '',
      'Navazuju na naši dohodu — 450 CZK/m2, 3 roky s opcí, super.',
      'Máš nějakou zpětnou vazbu k těm dvěma bodům od právníka?',
      '(ta výpovědní lhůta a parkování)',
      '',
      'Každopádně bychom rádi co nejdřív finalizovali.',
      'Můžem zítra ráno kolem 9 nebo 10 hodin doladit poslední detaily?',
      'Stačil by rychlej telefonát — projdeme ty dva body a domluvíme podpis.',
      '',
      'Potřebujeme se nastěhovat do dubna, takže trochu spěchám :)',
      '',
      'Díky!',
      'Eva',
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
  // Tomáš Horák — vacation announcement (snooze trigger)
  // Has 2-email history via bulk. This new email should trigger triage → revisit_at.
  {
    cpKey: 'tomas',
    from: TOMAS_FROM,
    subject: `Re: ${TOMAS_SUBJECT}`,
    body: [
      'Ahoj,',
      '',
      'díky za info, ten byt zní super!',
      'Ale zítra letíme s partnerkou na 3 týdny do Chorvatska.',
      'Můžeme se domluvit na prohlídku až po návratu?',
      'Budu zpátky kolem 5. května.',
      '',
      'Ozveme se hned jak přiletíme. Snad byt bude ještě volný!',
      '',
      'Tomáš',
    ].join('\n'),
  },
  // JUDr. Krejčí — lawyer (service CP, no lead tracking)
  {
    cpKey: 'lawyer',
    from: KREJCI_FROM,
    subject: `[${RUN_ID}] Revize kupní smlouvy — Vinohrady`,
    body: [
      'Dobrý den,',
      '',
      'jsem JUDr. Krejčí z advokátní kanceláře Krejčí & Partners.',
      'Pan Novotný mě pověřil revizí kupní smlouvy k nemovitosti na Vinohradech.',
      '',
      'Smlouvu jsem obdržel a procházím ji. Předpokládám, že budu mít',
      'připomínky hotové do pátku. Zatím jsem nenašel žádné zásadní problémy.',
      '',
      'Prosím o zaslání aktuálního listu vlastnictví a potvrzení bezdlužnosti SVJ',
      'na tuto adresu — potřebuji je pro ověření údajů ve smlouvě.',
      '',
      'S pozdravem,',
      'JUDr. Martin Krejčí',
      'Krejčí & Partners, advokátní kancelář',
      'Národní 18, Praha 1',
    ].join('\n'),
  },
]

const HIGH_PRIORITY_EMAIL: TestEmail = {
  cpKey: 'urgent',
  from: NOVOTNY_FROM,
  subject: `[${RUN_ID}] URGENTNÍ: 45M obchod — podpis u notáře zítra ráno`,
  body: [
    'URGENTNÍ — NUTNÁ OKAMŽITÁ ODPOVĚĎ',
    '',
    'Navazuji na naši korespondenci ohledně budovy na Vinohradech.',
    'Kupující potvrdil 45 000 000 Kč — finální cena dle naší dohody.',
    '',
    'Smlouva je hotová, JUDr. Procházka má volný termín ZÍTRA v 9:00.',
    'Schůzka u notáře: Třinecká 672, Praha.',
    '',
    'Potřebuji vaše potvrzení DNES do 17:00, jinak obchod padne.',
    'Stále nemám list vlastnictví a bezdlužnost SVJ, které jste slíbil.',
    'Kupující má další nemovitost v záloze a odejde.',
    '',
    'Potřebné dokumenty na zítřek:',
    '- Podepsaná kupní smlouva (máte od mého právníka)',
    '- List vlastnictví (ne starší 3 dny)',
    '- Potvrzení bezdlužnosti SVJ',
    '- Plná moc (originál)',
    '',
    'Toto je největší obchod tohoto čtvrtletí. Prosím, odpovězte IHNED.',
    '',
    'Jan Novotný',
    'Senior Broker, Prague Commercial',
    'Třinecká 672, Praha',
  ].join('\n'),
}

const ALL_TEST_SENDERS = [...TEST_EMAILS, HIGH_PRIORITY_EMAIL]

// ─── Hardcoded Round 2 CP responses ─────────────────────────────────────────

const CP_ROUND2_RESPONSES: Record<string, string> = {
  bob: [
    'Díky za odpověď!',
    '',
    'Čas na prohlídku mi vyhovuje. Vzal bych s sebou manželku — je to pro oba.',
    'Ještě jedna věc — je u domu možnost parkování? Máme dvě auta.',
    '',
    'Bob',
  ].join('\n'),

  eva: [
    'Ahoj,',
    '',
    'díky za rychlou odpověď. Čas na telefonát mi sedí.',
    '',
    'K těm dvěma bodům — právník trvá na 6 měsících výpovědní lhůty,',
    'to je pro nás podmínka. A ta 3 parkovací místa potřebujeme potvrdit písemně.',
    '',
    'Kdy budeme moct domluvit termín podpisu?',
    '',
    'Eva',
    'Dvorak & Partners s.r.o.',
  ].join('\n'),

  martin: [
    'Dobrý den,',
    '',
    'financování je schváleno, banka má podepsané dokumenty.',
    'Jsem k dispozici v pondělí nebo v úterý dopoledne pro schůzku u notáře.',
    '',
    'Kdy to můžeme uzavřít?',
    '',
    'Martin Král',
  ].join('\n'),

  urgent: [
    'Potřebuji jasnou odpověď — kdy přijdou ty dokumenty?',
    '',
    'List vlastnictví a bezdlužnost SVJ — bez toho notář nepůjde dopředu.',
    'Kupující mi volal před hodinou a zvažuje Žižkov znovu.',
    '',
    'Pokud nemám dokumenty do 15:00, musím přesunout termín u notáře.',
    '',
    'Novotný',
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
  urgency: number
  dollar_value: number
  payload: Record<string, unknown>
}

interface AgentResult {
  success: boolean
  emailsIngested: number
  whatsappMessagesProcessed: number
  calendarEventsSynced: number
  calendarInvitationsDetected: number
  messagesProcessed: number
  conversationsUpdated: number
  actionsGenerated: number
  followUpsGenerated: number
  coolingLeads: number
  coldLeads: number
  reflectionObservations: number
  replyDraftsGenerated: number
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
  log(`${roundLabel}:agent`, `  Cooling leads:         ${result.coolingLeads || 0}`)
  log(`${roundLabel}:agent`, `  Cold leads:            ${result.coldLeads || 0}`)
  log(`${roundLabel}:agent`, `  Journal observations:  ${result.reflectionObservations || 0}`)
  if (result.actions?.length) {
    log(`${roundLabel}:agent`, `  Action details:`)
    for (const a of result.actions) {
      log(`${roundLabel}:agent`, `    - [${a.action_type}] ${a.intent_cs || a.rationale} (score: ${a.priority_score}, urgency: ${a.urgency})`)
    }
  }
  if (result.errors?.length) {
    log(`${roundLabel}:agent`, `  Errors: ${result.errors.join(', ')}`)
  }
  // AI usage + cost summary
  const usage = (result as Record<string, unknown>).aiUsage as {
    stages: { stage: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUSD: number }[]
    totalInputTokens: number; totalOutputTokens: number; totalCalls: number; totalCostUSD: number
  } | undefined
  if (usage && usage.totalCalls > 0) {
    log(`${roundLabel}:agent`, `  AI usage: ${usage.totalCalls} calls, ${usage.totalInputTokens} in / ${usage.totalOutputTokens} out tokens — $${usage.totalCostUSD.toFixed(4)}`)
    for (const s of usage.stages) {
      log(`${roundLabel}:agent`, `    ${s.stage} → ${s.model}: ${s.calls}× (${s.inputTokens}→${s.outputTokens} tok) $${s.costUSD.toFixed(4)}`)
    }
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

// ─── Get hardcoded Round 2 CP response ──────────────────────────────────────

function getCPRound2Response(cpKey: string): string {
  return CP_ROUND2_RESPONSES[cpKey] ?? ''
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

    const responseBody = getCPRound2Response(original.cpKey)

    if (!responseBody) {
      log('respond', `  - No Round 2 response defined for ${original.cpKey}, skipping`)
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

// ─── Inject self-addressed email (command interface) ────────────────────────

async function injectSelfEmail(userId: string, subject: string, body: string): Promise<string> {
  log('command', `Injecting self-email command: "${subject.replace(`[${RUN_ID}] `, '')}"`)

  const gmail = await getGmailClient(userId)
  const userEmail = await getUserEmail(userId)
  const rfcMessageId = `<${RUN_ID}-self-cmd@e2e-test.local>`

  const rfc2822 = [
    `From: ${userEmail}`,
    `To: ${userEmail}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${rfcMessageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n')

  const res = await gmail.users.messages.insert({
    userId: 'me',
    requestBody: { raw: encodeRaw(rfc2822), labelIds: ['INBOX', 'UNREAD'] },
    internalDateSource: 'dateHeader',
  })

  log('command', `  ✓ Self-email injected → ${res.data.id}`)
  return res.data.id || 'unknown'
}

// ─── Quick smoke test ───────────────────────────────────────────────────────

async function runQuickMode(): Promise<void> {
  console.log()
  console.log('─── Quick Smoke Test ───────────────────────────────────')
  console.log('  Inject 1 urgent email → agent → instant-notify → done')
  console.log()

  const [injectedEmail] = await injectEmails(USER_ID, [HIGH_PRIORITY_EMAIL])

  const result = await runAgent(USER_ID, 'quick')

  const checks: CheckResult[] = [
    {
      name: 'Quick: Email ingested',
      pass: result.emailsIngested >= 1,
      detail: `${result.emailsIngested} email(s)`,
    },
    {
      name: 'Quick: Action generated',
      pass: result.actionsGenerated >= 1,
      detail: `${result.actionsGenerated} action(s)`,
    },
    {
      name: 'Quick: Urgent action (urgency >= 9)',
      pass: (result.actions || []).some(a => a.urgency >= 9),
      detail: `${(result.actions || []).filter(a => a.urgency >= 9).length} urgent action(s)`,
    },
  ]

  const notifyResult = await runInstantNotify()
  checks.push({
    name: 'Quick: Instant notification sent',
    pass: notifyResult.sent >= 1,
    detail: `sent=${notifyResult.sent}`,
  })

  console.log()
  const allPassed = printChecks(checks)

  if (result.actions?.length) {
    printActionUrls(result.actions, USER_ID)
    await waitForKeypress('  ⏎  Press Enter when done...\n')
  }

  console.log()
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  QUICK RESULT: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`)
  console.log('═══════════════════════════════════════════════════════')

  if (!allPassed) process.exit(1)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const multiRound = !flags.has('--single-round')

  BASE_URL = await detectBaseUrl()

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Mila E2E Pipeline Test — Interactive')
  const quickMode = flags.has('--quick')
  const modeLabel = quickMode ? 'Quick Smoke Test' : multiRound ? 'Multi-Round Interactive' : 'Single Round'
  console.log(`  Mode: ${modeLabel}`)
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

  // ── Quick mode: minimal smoke test, ~30s ──────────────────────────────
  if (quickMode) {
    await runQuickMode()
    return
  }

  const allChecks: CheckResult[] = []

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
      // Eva: full back-and-forth on Sokolovská office (settled at 450 CZK/m2, 3yr).
      // Novotný: commercial building in Vinohrady (45M, months of pushback). User's last reply 6d ago.
      // Klára: villa buyer in Dejvice (9.5M). User sent follow-up 11d ago, CP silent → cooling lead.
      console.log()
      console.log('─── Phase 0: Injecting Conversation History ────────────')

      await injectHistoryThread(USER_ID, EVA_NEGOTIATION_HISTORY, 'eva-negotiation')
      await injectHistoryThread(USER_ID, NOVOTNY_NEGOTIATION_HISTORY, 'novotny-negotiation')
      await injectHistoryThread(USER_ID, KLARA_NEGOTIATION_HISTORY, 'klara-dejvice')
      await injectHistoryThread(USER_ID, TOMAS_HISTORY, 'tomas-kosire')

      // Run bulk ingestion to process history — ingest, enrich, thread, summarize.
      // NO action generation — history is context only, not new work.
      log('history', 'Running bulk ingestion to process history emails...')
      const sinceDate = new Date()
      sinceDate.setDate(sinceDate.getDate() - 40) // cover all history emails (Novotný goes back 35d)
      const bulkRes = await fetch(`${BASE_URL}/api/ingest/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ userId: USER_ID, since: sinceDate.toISOString(), maxTotal: 100 }),
        signal: AbortSignal.timeout(300_000),
      })
      const bulkText = await bulkRes.text()
      const bulkLines = bulkText.trim().split('\n').filter(Boolean)
      for (const line of bulkLines.slice(-3)) {
        log('history', `  ${line.trim()}`)
      }
      log('history', 'History processed via bulk ingestion (no actions generated)')

      // ── Self-email command injection ──────────────────────────────────
      // Injected now so the first agent run in Phase 1 picks it up.
      // Trace: new CP "Petr Svoboda" in cps table.
      await injectSelfEmail(USER_ID, SELF_EMAIL_COMMAND.subject, SELF_EMAIL_COMMAND.body)

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

    // ── Post-refactor feature checks ──────────────────────────────────
    // These verify pipeline steps that were added/changed in recent refactors.
    // The agent result already returns these counts — we just weren't checking.

    const totalCooling = allR1Results.reduce((sum, r) => sum + (r.coolingLeads || 0), 0)
    const totalFollowUps = allR1Results.reduce((sum, r) => sum + (r.followUpsGenerated || 0), 0)
    const totalReflections = allR1Results.reduce((sum, r) => sum + (r.reflectionObservations || 0), 0)

    // Klára: 11 days since user's last message, CP silent → should be cooling
    r1Checks.push({
      name: 'R1: Cooling lead detected (Klára)',
      pass: totalCooling > 0,
      detail: `${totalCooling} cooling lead(s) — Klára silent 11+ days`,
    })

    // Lead tracking should generate follow-up actions for cooling leads
    r1Checks.push({
      name: 'R1: Lead follow-up actions generated',
      pass: totalFollowUps > 0,
      detail: `${totalFollowUps} follow-up action(s)`,
    })

    // Journal: rich negotiation histories (Eva 11 msgs, Novotný 13 msgs) should produce observations
    r1Checks.push({
      name: 'R1: Journal observations extracted',
      pass: totalReflections > 0,
      detail: `${totalReflections} observation(s) from conversations`,
    })

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
    // DB TRACES — what to verify in Supabase after the run
    // ═══════════════════════════════════════════════════════════════════════
    console.log()
    console.log('─── DB Traces to Verify ────────────────────────────────')
    console.log('  Check these in Supabase to confirm pipeline correctness:')
    console.log()
    console.log('  SNOOZE (Tomáš Horák — vacation):')
    console.log('    → conversation_threads WHERE topic ILIKE \'%Košíře%\' OR \'%Popelce%\'')
    console.log('    → snooze_until should be set (~2026-05-05)')
    console.log('    → No follow-up action for this conversation')
    console.log()
    console.log('  SERVICE CP (JUDr. Krejčí — lawyer):')
    console.log('    → cps WHERE name ILIKE \'%Krejčí%\'')
    console.log('    → role should be \'lawyer\' (set by enrichment)')
    console.log('    → No lead tracking follow-up action (service CP bypass)')
    console.log('    → May have a REPLY/TODO action (lawyer asked for documents — that\'s correct)')
    console.log()
    console.log('  SELF-EMAIL COMMAND (Mila: nový kontakt):')
    console.log('    → cps WHERE name ILIKE \'%Svoboda%\'')
    console.log('    → phone should contain \'602555123\', role = \'buyer\'')
    console.log()
    console.log('  COOLING LEAD (Klára Marcinová):')
    console.log('    → conversation_threads WHERE topic ILIKE \'%Dejvice%\' OR \'%Antonínská%\'')
    console.log('    → Should have a follow-up action (lead tracking)')
    console.log()
    console.log('  JOURNAL (reflection):')
    console.log('    → journal_entries WHERE user_id = \'' + USER_ID + '\'')
    console.log('    → Should have observations from Eva/Novotný negotiations')
    console.log()

    // ═══════════════════════════════════════════════════════════════════════
    // FINAL: Morning brief with full conversation history
    // ═══════════════════════════════════════════════════════════════════════
    if (!flags.has('--skip-brief')) {
      console.log()
      console.log('─── Final: Morning Brief ───────────────────────────────')
      await runBrief(USER_ID)
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
}

main().catch(err => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
