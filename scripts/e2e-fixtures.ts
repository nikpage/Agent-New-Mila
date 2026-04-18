/**
 * E2E test fixtures — hand-authored Czech negotiation scenarios.
 *
 * Ground truth input data. Pure data exports, no logic.
 * Used by both e2e-test.ts (interactive) and e2e-pipeline.ts (headless batch).
 *
 * Runner prepends [RUN_ID] to subjectSuffix at send time for uniqueness.
 */

export interface FixtureHistoryEmail {
  cpKey: string
  direction: 'inbound' | 'outbound'
  from: string
  subjectSuffix: string
  daysAgo: number
  body: string
}

export interface FixtureCurrentEmail {
  cpKey: string
  from: string
  subjectSuffix: string
  body: string
}

// ─── Counterparties ──────────────────────────────────────────────────────────

export const EVA_EMAIL = 'ainikpage+dvorakova.eva@gmail.com'
export const EVA_FROM = 'Eva Dvorakova <ainikpage+dvorakova.eva@gmail.com>'
export const EVA_SUBJECT = 'Karlin office space — Sokolovská'

export const NOVOTNY_EMAIL = 'ainikpage+novotny.jan@gmail.com'
export const NOVOTNY_FROM = 'Jan Novotny <ainikpage+novotny.jan@gmail.com>'
export const NOVOTNY_SUBJECT = 'Komerční budova Vinohrady — nabídka'

export const KLARA_EMAIL = 'ainikpage+KlaraMarcinova@gmail.com'
export const KLARA_FROM = 'Klara Marcinova <ainikpage+KlaraMarcinova@gmail.com>'
export const KLARA_SUBJECT = 'Vila Dejvice — Antonínská 12'

export const TOMAS_EMAIL = 'ainikpage+horak.tomas@gmail.com'
export const TOMAS_FROM = 'Tomas Horak <ainikpage+horak.tomas@gmail.com>'
export const TOMAS_SUBJECT = 'Zahradní byt Košíře — Na Popelce'

export const KREJCI_EMAIL = 'ainikpage+krejci.martin@gmail.com'
export const KREJCI_FROM = 'JUDr. Martin Krejci <ainikpage+krejci.martin@gmail.com>'

// ─── Eva history (lease negotiation, settled at 450 CZK/m2, 3yr + opt) ──────

export const EVA_HISTORY: FixtureHistoryEmail[] = [
  {
    cpKey: 'eva', direction: 'inbound', from: EVA_FROM, subjectSuffix: EVA_SUBJECT, daysAgo: 28,
    body: [
      'Ahoj!', '',
      'Narazila jsem na váš inzerát kancelářských prostor v Karlíně na Sokolovské',
      'a úplně mě to nadchlo — přesně tohle hledáme pro Dvorak & Partners.',
      'Potřebujeme cca 200m2, ideálně open plan s pár zasedačkami.', '',
      'Mohli byste nám poslat podrobnosti? Půdorys, cena za m2, podmínky nájmu...', '',
      'Díky moc,', 'Eva Dvořáková', 'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  {
    cpKey: 'eva', direction: 'outbound', from: EVA_FROM, subjectSuffix: `Re: ${EVA_SUBJECT}`, daysAgo: 27,
    body: [
      'Dobrý den Evo,', '',
      'díky za zájem! Posílám podklady:',
      '- Půdorys třetího patra (Sokolovská 46/51, Praha 8): 200m2 open plan, 2 zasedačky, kuchyňka',
      '- Cena: 465 CZK/m2/měsíc, standardní nájemní podmínky (3 nebo 5 let)',
      '- Budova je po kompletní rekonstrukci, nová klimatizace + výtah', '',
      's pozdravem',
    ].join('\n'),
  },
  {
    cpKey: 'eva', direction: 'inbound', from: EVA_FROM, subjectSuffix: `Re: ${EVA_SUBJECT}`, daysAgo: 20,
    body: [
      'Díky za podklady! Prostory vypadají skvěle, byli jsme se podívat.', '',
      '465 CZK/m2 je trošku nad náš rozpočet.',
      'Co kdybychom nabídli 420 CZK/m2/měsíc s desetiletým závazkem?',
      'Celkem je to 10,08M Kč garantovaného příjmu — to není málo :)', '',
      'Eva', 'Dvorak & Partners s.r.o.', 'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  {
    cpKey: 'eva', direction: 'outbound', from: EVA_FROM, subjectSuffix: `Re: ${EVA_SUBJECT}`, daysAgo: 14,
    body: [
      'Evo,', '',
      'mluvil jsem se spolumajitelem. Naše finální nabídka:',
      '450 CZK/m2/měsíc na 3 roky s opcí na prodloužení za tržní cenu.',
      'Níže nejdeme — ale ta opce vám dá jistotu do budoucna.',
    ].join('\n'),
  },
  {
    cpKey: 'eva', direction: 'inbound', from: EVA_FROM, subjectSuffix: `Re: ${EVA_SUBJECT}`, daysAgo: 9,
    body: [
      'Ahoj!', '',
      'Probrala jsem to s vedením — souhlasíme!',
      '450 CZK/m2/měsíc na 3 roky s opcí na prodloužení za tržní cenu.', '',
      'Kdy bychom mohli domluvit podpis? Potřebujeme se nastěhovat',
      'do poloviny dubna — ideálně bych chtěla mít smlouvu hotovou co nejdřív.', '',
      'Eva',
    ].join('\n'),
  },
  {
    cpKey: 'eva', direction: 'inbound', from: EVA_FROM, subjectSuffix: `Re: ${EVA_SUBJECT}`, daysAgo: 5,
    body: [
      'Ahoj,', '',
      'Náš právník prošel návrh smlouvy — říká, že je to v pohodě,',
      'jen má dvě drobné připomínky:',
      '1) Výpovědní lhůta — chtěli bychom 6 měsíců místo 3 (prostě pro jistotu)',
      '2) Parkování — potřebujeme potvrdit 3 místa v garážích pro naše lidi', '',
      'Jinak jsme připravení podepsat! Už se těšíme na stěhování :)',
      'Dejte vědět, kdy to můžeme uzavřít.', '',
      'Eva', 'Dvorak & Partners s.r.o.', 'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
]

// ─── Novotný history (aggressive commercial sale, settled at 45M) ──────────

export const NOVOTNY_HISTORY: FixtureHistoryEmail[] = [
  {
    cpKey: 'urgent', direction: 'inbound', from: NOVOTNY_FROM, subjectSuffix: NOVOTNY_SUBJECT, daysAgo: 35,
    body: [
      'Dobrý den,', '',
      'Jan Novotný z Prague Commercial. Mám klienta, který hledá',
      'komerční nemovitost v Praze 2 — viděli jsme vaši budovu na Vinohradech.', '',
      'Můžete nám poslat podrobnosti? Zajímá nás celková užitná plocha,',
      'stav budovy, aktuální obsazenost a požadovaná cena.', '',
      'Klient má rozpočet kolem 40M Kč a může uzavřít rychle.', '',
      'Jan Novotný', 'Senior Broker, Prague Commercial', 'Třinecká 672, Praha',
    ].join('\n'),
  },
  {
    cpKey: 'urgent', direction: 'outbound', from: NOVOTNY_FROM, subjectSuffix: `Re: ${NOVOTNY_SUBJECT}`, daysAgo: 34,
    body: [
      'Dobrý den pane Novotný,', '',
      'posílám základní informace k budově na Vinohradech:',
      '- Celková užitná plocha: 1 200 m2 (6 podlaží)',
      '- Obsazenost: 85% (10 z 12 jednotek pronajato)',
      '- Průměrný výnos z nájmů: 180 000 Kč/měsíc',
      '- Požadovaná cena: 48 000 000 Kč', '',
      'Budova je v centru Prahy 2, vynikající lokalita pro investici.',
      's pozdravem',
    ].join('\n'),
  },
  {
    cpKey: 'urgent', direction: 'inbound', from: NOVOTNY_FROM, subjectSuffix: `Re: ${NOVOTNY_SUBJECT}`, daysAgo: 28,
    body: [
      '48M je příliš. Budova potřebuje novou fasádu a výtah neprošel revizí.',
      'Nabízíme 38M Kč s uzavřením do 60 dnů.', '',
      'Dejte mi vědět do pátku — klient se dívá ještě na Žižkov.', '',
      'Novotný',
    ].join('\n'),
  },
  {
    cpKey: 'urgent', direction: 'outbound', from: NOVOTNY_FROM, subjectSuffix: `Re: ${NOVOTNY_SUBJECT}`, daysAgo: 27,
    body: [
      'Pane Novotný,', '',
      '38M je hluboko pod tržní cenou. Nájemní výnos 2,16M Kč ročně = yield 4,5% při 48M.',
      'Přistoupím na 45 000 000 Kč — finální cena, žádné další slevy.', '',
      'Žižkov není Praha 2. Vaší klient ví proč hledá na Vinohradech.',
    ].join('\n'),
  },
  {
    cpKey: 'urgent', direction: 'inbound', from: NOVOTNY_FROM, subjectSuffix: `Re: ${NOVOTNY_SUBJECT}`, daysAgo: 7,
    body: [
      'Klient souhlasí s 45M Kč — vaše argumenty ho přesvědčily.', '',
      'Potřebuji od vás:',
      '1) Aktuální list vlastnictví (ne starší než 3 dny)',
      '2) Potvrzení o bezdlužnosti SVJ',
      '3) Energetický průkaz budovy', '',
      'Navrhuji notáře JUDr. Procházku na Třinecké 672.', '',
      'Jan Novotný', 'Prague Commercial', 'Třinecká 672, Praha',
    ].join('\n'),
  },
  {
    cpKey: 'urgent', direction: 'outbound', from: NOVOTNY_FROM, subjectSuffix: `Re: ${NOVOTNY_SUBJECT}`, daysAgo: 6,
    body: [
      'Pane Novotný,', '',
      'výborně. Připravuji dokumenty:',
      '- List vlastnictví: objednám na katastru dnes, hotový do 2 dnů',
      '- Bezdlužnost SVJ: čekám na správce, slíbil do pátku',
      '- Energetický průkaz: posílám v příloze', '',
      'JUDr. Procházka na Třinecké 672 mi vyhovuje.',
    ].join('\n'),
  },
  {
    cpKey: 'urgent', direction: 'inbound', from: NOVOTNY_FROM, subjectSuffix: `Re: ${NOVOTNY_SUBJECT}`, daysAgo: 3,
    body: [
      'Potřebuji ty dokumenty co nejdřív — kupující tlačí.', '',
      'List vlastnictví a bezdlužnost SVJ jste slíbil poslat včera.',
      'Právník má smlouvu hotovou a čeká jen na to.', '',
      'Pokud nepodepíšeme do konce týdne,',
      'nemůžu garantovat, že nabídka 45M bude stále na stole.', '',
      'Prosím, pošlete dokumenty DNES.', '',
      'Novotný',
    ].join('\n'),
  },
]

// ─── Klára history (cooling buyer, 11 days silent) ──────────────────────────

export const KLARA_HISTORY: FixtureHistoryEmail[] = [
  {
    cpKey: 'klara', direction: 'inbound', from: KLARA_FROM, subjectSuffix: KLARA_SUBJECT, daysAgo: 24,
    body: [
      'Dobrý den,', '',
      'narazila jsem na váš inzerát vily na Antonínské 12 v Dejvicích.',
      'Hledáme rodinný dům v Praze 6 — manžel pracuje v Bubenči a já',
      'pracuju v centru, takže Dejvice jsou pro nás ideální.', '',
      'Mohli byste mi poslat více informací? Zajímá nás dispozice,',
      'stav zahrady, možnost parkování a přesná cena.', '',
      'S pozdravem,', 'Klára Marcinová',
    ].join('\n'),
  },
  {
    cpKey: 'klara', direction: 'outbound', from: KLARA_FROM, subjectSuffix: `Re: ${KLARA_SUBJECT}`, daysAgo: 23,
    body: [
      'Dobrý den paní Marcinová,', '',
      'děkuji za zájem! Posílám detaily k vile na Antonínské 12:',
      '- Dispozice: 5+1, 280 m2 užitné plochy, pozemek 650 m2',
      '- Zahrada: udržovaná, terasa, pergola, garáž pro 2 auta',
      '- Stav: po rekonstrukci 2021 (kuchyně, koupelny, podlahy)',
      '- Cena: 9 800 000 Kč', '',
      'Dejvice, klidná ulice 5 minut pěšky od metra Hradčanská.', '',
      'Rád domluvím prohlídku — jsem k dispozici příští týden.',
      's pozdravem',
    ].join('\n'),
  },
  {
    cpKey: 'klara', direction: 'inbound', from: KLARA_FROM, subjectSuffix: `Re: ${KLARA_SUBJECT}`, daysAgo: 21,
    body: [
      'Dobrý den,', '',
      'to zní skvěle! Pár doplňujících otázek:',
      '- Jsou v ceně také veškeré spotřebiče?',
      '- Jak stará je střecha?',
      '- Je možné se nastěhovat do konce června?', '',
      'Prohlídka: mohlo by to být v úterý nebo ve středu odpoledne?',
      'Nejlépe kolem 16h, manžel by šel se mnou.', '',
      'Klára',
    ].join('\n'),
  },
  {
    cpKey: 'klara', direction: 'outbound', from: KLARA_FROM, subjectSuffix: `Re: ${KLARA_SUBJECT}`, daysAgo: 20,
    body: [
      'Paní Marcinová,', '',
      'spotřebiče: ano, vše v ceně (Bosch kuchyně, myčka, lednička).',
      'Střecha: 2019, v perfektním stavu, pojistka do 2029.',
      'Nastěhování do konce června: určitě možné, ideální timing.', '',
      'Prohlídka: úterý ve 16h mi vyhovuje. Adresa Antonínská 12, Praha 6 —',
      'zaparkovat lze přímo u domu nebo v přilehlé ulici.', '',
      'Těším se na setkání.',
    ].join('\n'),
  },
  {
    cpKey: 'klara', direction: 'inbound', from: KLARA_FROM, subjectSuffix: `Re: ${KLARA_SUBJECT}`, daysAgo: 17,
    body: [
      'Dobrý den,', '',
      'díky za prohlídku — vila je krásná, manžel i já jsme si to oblíbili.',
      'Ta zahrada a garáž jsou přesně to, co hledáme.', '',
      'Jediné co nás trošku zarazilo — cena. 9,8M je na hraně našeho rozpočtu.',
      'Je prostor pro vyjednávání? Třeba 9,3-9,4M?', '',
      'Jinak bychom velmi rádi šli dál. Ještě bychom chtěli jednou projet',
      's rodiči, kteří nám pomáhají s financováním.', '',
      'Klára',
    ].join('\n'),
  },
  {
    cpKey: 'klara', direction: 'outbound', from: KLARA_FROM, subjectSuffix: `Re: ${KLARA_SUBJECT}`, daysAgo: 11,
    body: [
      'Paní Marcinová,', '',
      'rád, že se vila líbila! K ceně: 9,5M Kč je můj konečný limit —',
      'pod to nejdu, ale to snížení od 9,8M je pro vás 300 000 Kč navíc.', '',
      'Druhá prohlídka s rodiči je samozřejmě vítaná.',
      'Dám vám vědět o dalších zájemcích, pokud by se situace změnila.', '',
      'Kdy by rodiče mohli přijet? Jsem k dispozici tento nebo příští týden.',
    ].join('\n'),
  },
]

// ─── Tomáš history (buyer about to go on vacation) ──────────────────────────

export const TOMAS_HISTORY: FixtureHistoryEmail[] = [
  {
    cpKey: 'tomas', direction: 'inbound', from: TOMAS_FROM, subjectSuffix: TOMAS_SUBJECT, daysAgo: 8,
    body: [
      'Dobrý den,', '',
      'viděl jsem váš inzerát na zahradní byt Na Popelce v Košířích.',
      'Hledáme s partnerkou byt se zahrádkou v Praze 5 — máme rozpočet kolem 6,5M.', '',
      'Je byt stále k dispozici? Mohli bychom ho vidět tento týden?', '',
      'Díky,', 'Tomáš Horák',
    ].join('\n'),
  },
  {
    cpKey: 'tomas', direction: 'outbound', from: TOMAS_FROM, subjectSuffix: `Re: ${TOMAS_SUBJECT}`, daysAgo: 7,
    body: [
      'Dobrý den pane Horáku,', '',
      'byt je k dispozici — 3+kk, 78m2, zahrada 45m2, cena 6 900 000 Kč.',
      'Po rekonstrukci 2023, klidná ulice.', '',
      'Prohlídku můžeme domluvit na čtvrtek nebo pátek odpoledne.',
      'Dejte vědět, co vám vyhovuje.',
    ].join('\n'),
  },
]

// ─── Current test emails (what triggers the test round) ─────────────────────

export const TEST_EMAILS: FixtureCurrentEmail[] = [
  {
    cpKey: 'bob',
    from: 'Bob <ainikpage+Bob@gmail.com>',
    subjectSuffix: 'Poptávka — byt Vinohradská 45',
    body: [
      'Dobrý den,', '',
      'Viděl jsem vaši nabídku bytu na Vinohradské 45 v Praze. Je ještě k dispozici?',
      'Zvažujeme různé možnosti v příštích měsících a tento byt nás zaujal.', '',
      'Můj rozpočet je přibližně 8 500 000 Kč. Je prostor pro vyjednávání?',
      'Žádný spěch — ozvi se, až budeš mít chvíli.', '',
      'Díky,', 'Bob',
    ].join('\n'),
  },
  {
    cpKey: 'eva',
    from: EVA_FROM,
    subjectSuffix: 'Podpis smlouvy — kancelář Sokolovská',
    body: [
      'Ahoj!', '',
      'Navazuju na naši dohodu — 450 CZK/m2, 3 roky s opcí, super.',
      'Máš nějakou zpětnou vazbu k těm dvěma bodům od právníka?',
      '(ta výpovědní lhůta a parkování)', '',
      'Každopádně bychom rádi co nejdřív finalizovali.',
      'Můžem zítra ráno kolem 9 nebo 10 hodin doladit poslední detaily?',
      'Stačil by rychlej telefonát — projdeme ty dva body a domluvíme podpis.', '',
      'Potřebujeme se nastěhovat do dubna, takže trochu spěchám :)', '',
      'Díky!', 'Eva', 'Dvorak & Partners s.r.o.',
      'Ďáblická, 182 00 Ďáblice, Czechia',
    ].join('\n'),
  },
  {
    cpKey: 'martin',
    from: 'Martin Kral <ainikpage+kral.martin@gmail.com>',
    subjectSuffix: 'Změna termínu uzavření — Smíchov',
    body: [
      'Dobrý den,', '',
      'Prodávající nemovitosti na Smíchově chce uzavřít obchod do konce dubna místo května.',
      'Kupní cena 12 400 000 Kč dle dohody.', '',
      'Můžete potvrdit, že je financování připraveno? Bankovní dokumenty',
      'bychom měli vyřídit v průběhu příštích dvou týdnů.', '',
      'Martin Král',
    ].join('\n'),
  },
  {
    cpKey: 'tomas',
    from: TOMAS_FROM,
    subjectSuffix: `Re: ${TOMAS_SUBJECT}`,
    body: [
      'Ahoj,', '',
      'díky za info, ten byt zní super!',
      'Ale zítra letíme s partnerkou na dva a půl týdne do Chorvatska.',
      'Můžeme se domluvit na prohlídku až po návratu?',
      'Budu zpátky kolem 5. května.', '',
      'Ozveme se hned jak přiletíme. Snad byt bude ještě volný!', '',
      'Tomáš',
    ].join('\n'),
  },
  {
    cpKey: 'lawyer',
    from: KREJCI_FROM,
    subjectSuffix: 'Revize kupní smlouvy — Vinohrady',
    body: [
      'Dobrý den,', '',
      'jsem JUDr. Krejčí z advokátní kanceláře Krejčí & Partners.',
      'Pan Novotný mě pověřil revizí kupní smlouvy k nemovitosti na Vinohradech.', '',
      'Smlouvu jsem obdržel a procházím ji. Předpokládám, že budu mít',
      'připomínky hotové do pátku. Zatím jsem nenašel žádné zásadní problémy.', '',
      'Prosím o zaslání aktuálního listu vlastnictví a potvrzení bezdlužnosti SVJ',
      'na tuto adresu — potřebuji je pro ověření údajů ve smlouvě.', '',
      'S pozdravem,', 'JUDr. Martin Krejčí',
      'Krejčí & Partners, advokátní kancelář', 'Národní 18, Praha 1',
    ].join('\n'),
  },
]

export const HIGH_PRIORITY_EMAIL: FixtureCurrentEmail = {
  cpKey: 'urgent',
  from: NOVOTNY_FROM,
  subjectSuffix: 'URGENTNÍ: 45M obchod — podpis u notáře zítra ráno',
  body: [
    'URGENTNÍ — NUTNÁ OKAMŽITÁ ODPOVĚĎ', '',
    'Navazuji na naši korespondenci ohledně budovy na Vinohradech.',
    'Kupující potvrdil 45 000 000 Kč — finální cena dle naší dohody.', '',
    'Smlouva je hotová, JUDr. Procházka má volný termín ZÍTRA v 9:00.',
    'Schůzka u notáře: Třinecká 672, Praha.', '',
    'Potřebuji vaše potvrzení DNES do 17:00, jinak obchod padne.',
    'Stále nemám list vlastnictví a bezdlužnost SVJ, které jste slíbil.',
    'Kupující má další nemovitost v záloze a odejde.', '',
    'Potřebné dokumenty na zítřek:',
    '- Podepsaná kupní smlouva (máte od mého právníka)',
    '- List vlastnictví (ne starší 3 dny)',
    '- Potvrzení bezdlužnosti SVJ',
    '- Plná moc (originál)', '',
    'Toto je největší obchod tohoto čtvrtletí. Prosím, odpovězte IHNED.', '',
    'Jan Novotný', 'Senior Broker, Prague Commercial', 'Třinecká 672, Praha',
  ].join('\n'),
}

export const ALL_CURRENT_EMAILS: FixtureCurrentEmail[] = [...TEST_EMAILS, HIGH_PRIORITY_EMAIL]

// ─── Self-email command (creates new CP Petr Svoboda) ──────────────────────

export const SELF_EMAIL_COMMAND = {
  subjectSuffix: 'Mila: nový kontakt',
  body: [
    'Petr Svoboda',
    'Tel: 602 555 123',
    'Email: petr.svoboda@remax.cz',
    'Role: buyer',
    'Hledá byt v Praze 3, rozpočet 4-5M',
  ].join('\n'),
}

// ─── All history threads (grouped for easier iteration) ─────────────────────

export const ALL_HISTORY_THREADS: { label: string; emails: FixtureHistoryEmail[] }[] = [
  { label: 'eva-negotiation', emails: EVA_HISTORY },
  { label: 'novotny-negotiation', emails: NOVOTNY_HISTORY },
  { label: 'klara-dejvice', emails: KLARA_HISTORY },
  { label: 'tomas-kosire', emails: TOMAS_HISTORY },
]
