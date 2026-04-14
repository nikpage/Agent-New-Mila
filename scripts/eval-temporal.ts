/**
 * Go/no-go evaluation for the Temporal DSL.
 * Tests 50 Czech temporal expressions against the LLM + DSL pipeline.
 *
 * Target: >90% valid (45+/50). Below 80% → redesign DSL or prompt.
 *
 * Usage:
 *   npx ts-node --project tsconfig.scripts.json scripts/eval-temporal.ts
 */

import * as dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.join(__dirname, '../.env.local') })

import { extractTemporalExpressions } from '../src/services/temporal-extractor'
import { DEFAULT_USER_SETTINGS } from '../src/lib/supabase/types'

// Fixed anchor: Wednesday 2026-04-15 10:00:00 local
const ANCHOR = new Date('2026-04-15T10:00:00')

interface TestCase {
  text: string
  description: string
}

const TEST_CASES: TestCase[] = [
  // Simple relative
  { text: 'Zavolám vám zítra.', description: 'tomorrow' },
  { text: 'Pošlu to pozítří.', description: 'day after tomorrow' },
  { text: 'Mám čas příští týden.', description: 'next week' },
  { text: 'Schůzka za 3 dny.', description: '+3 days' },
  { text: 'Uvidíme se za dva týdny.', description: '+2 weeks' },

  // Weekdays — next occurrence
  { text: 'Příští pondělí vám zavolám.', description: 'next Monday' },
  { text: 'Příští úterý odpoledne.', description: 'next Tuesday afternoon' },
  { text: 'Příští středu ráno.', description: 'next Wednesday morning' },
  { text: 'Příští čtvrtek v 10.', description: 'next Thursday at 10' },
  { text: 'Příští pátek je termín.', description: 'next Friday deadline' },

  // This week
  { text: 'Tento pátek to pošleme.', description: 'this Friday' },
  { text: 'Tento čtvrtek odpoledne.', description: 'this Thursday afternoon' },

  // With times
  { text: 'Zítra v 9:00.', description: 'tomorrow at 9' },
  { text: 'Zítra v 14:30.', description: 'tomorrow at 14:30' },
  { text: 'Zítra odpoledne kolem 15.', description: 'tomorrow around 15' },
  { text: 'Příští pátek v 10:30.', description: 'next Friday at 10:30' },
  { text: 'Ve středu ráno v 9.', description: 'Wednesday morning at 9' },
  { text: 'V pondělí kolem poledne.', description: 'Monday around noon' },

  // Deadlines
  { text: 'Potřebuji to do pátku.', description: 'by Friday' },
  { text: 'Pošlete mi to do konce týdne.', description: 'by end of week' },
  { text: 'Musíme to dokončit do zítřka.', description: 'by tomorrow' },
  { text: 'Do příštího pondělí.', description: 'by next Monday' },
  { text: 'Do konce dne.', description: 'by end of day' },

  // Absolute dates
  { text: 'Schůzka 20. dubna.', description: 'April 20' },
  { text: 'Termín je 1. května.', description: 'May 1' },
  { text: 'Notář 15. března 2026.', description: 'March 15 2026' },
  { text: 'Podpis 30. června.', description: 'June 30' },
  { text: 'Výpis k 1. lednu 2027.', description: 'January 1 2027' },

  // Time of day only
  { text: 'Ráno to vyřešíme.', description: 'morning (no specific day)' },
  { text: 'Odpoledne zavolám.', description: 'afternoon (no specific day)' },
  { text: 'Dnes odpoledne.', description: 'this afternoon' },
  { text: 'Dnes ráno v 9.', description: 'this morning at 9' },

  // Complex / compound
  { text: 'Příští týden ve středu dopoledne kolem 10.', description: 'next week Wednesday ~10am' },
  { text: 'Za týden v pátek odpoledne.', description: '+1 week Friday afternoon' },
  { text: 'V pondělí nebo v úterý ráno.', description: 'Monday or Tuesday morning' },
  { text: 'Příští pátek nebo sobotu.', description: 'next Fri or Sat' },

  // Realistic message fragments
  { text: 'Mohu vás navštívit zítra mezi 14 a 16?', description: 'tomorrow between 14-16' },
  { text: 'Bylo by možné ve čtvrtek dopoledne?', description: 'Thursday morning?' },
  { text: 'Jsem volný příští týden kdykoli po 10.', description: 'next week after 10' },
  { text: 'Podpis smlouvy plánujeme na 25. dubna.', description: 'contract signing Apr 25' },
  { text: 'Kolaudace je naplánována na 5. května 2026.', description: 'handover May 5 2026' },
  { text: 'Termín pro podání nabídky je do 30. dubna.', description: 'offer deadline Apr 30' },

  // Edge cases
  { text: 'Hned jak to půjde, příští týden nejspíš.', description: 'probably next week' },
  { text: 'Někdy příští týden.', description: 'sometime next week' },
  { text: 'Do konce příštího týdne.', description: 'by end of next week' },
  { text: 'V pátek odpoledne, nejlépe kolem 15 nebo 16.', description: 'Friday 15 or 16' },
  { text: 'Rezervace na 22. dubna v 11:00.', description: 'booking Apr 22 at 11' },
  { text: 'Termín odevzdání: středa 22. dubna.', description: 'deadline Wed Apr 22' },
]

async function main() {
  console.log(`Temporal DSL eval — ${TEST_CASES.length} test cases`)
  console.log(`Anchor: ${ANCHOR.toISOString()}\n`)

  let valid = 0
  let failed = 0
  let noExpression = 0

  const failures: string[] = []

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]
    process.stdout.write(`[${String(i + 1).padStart(2)}/${TEST_CASES.length}] ${tc.description.padEnd(35)} `)

    try {
      const result = await extractTemporalExpressions(tc.text, ANCHOR, DEFAULT_USER_SETTINGS)

      if (result.expressions.length === 0) {
        console.log('NO EXPRESSIONS FOUND')
        noExpression++
        failures.push(`${i + 1}. ${tc.description}: no expressions`)
        continue
      }

      const first = result.expressions[0]
      if (first.resolved_date) {
        const d = new Date(first.resolved_date)
        console.log(`OK  ${d.toISOString().slice(0, 16)}  code: ${first.generated_code}`)
        valid++
      } else {
        console.log(`ERR  ${first.execution_error?.slice(0, 60)}  code: ${first.generated_code}`)
        failed++
        failures.push(`${i + 1}. ${tc.description}: ${first.execution_error}`)
      }
    } catch (err) {
      console.log(`EXCEPTION  ${err}`)
      failed++
      failures.push(`${i + 1}. ${tc.description}: exception — ${err}`)
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200))
  }

  const total = TEST_CASES.length
  const score = valid / total
  console.log('\n─────────────────────────────────────')
  console.log(`Valid:       ${valid}/${total} (${Math.round(score * 100)}%)`)
  console.log(`No match:    ${noExpression}`)
  console.log(`Exec error:  ${failed}`)
  console.log(`\nVerdict: ${score >= 0.90 ? '✅ GO — target met (≥90%)' : score >= 0.80 ? '⚠️  MARGINAL — above 80% floor but below 90% target' : '❌ NO-GO — below 80% floor, redesign DSL'}`)

  if (failures.length > 0) {
    console.log('\nFailures:')
    failures.forEach(f => console.log(`  ${f}`))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
