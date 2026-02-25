/**
 * Priority Scoring Prototype — Compare 3 normalization approaches
 *
 * Run: npx tsx scripts/scoring-prototype.ts
 *
 * Approaches:
 * 1. CURRENT: dollarValue / kcFactor (linear, kcFactor=13)
 * 2. FIBONACCI: map dollarValue to nearest Fib number using log thresholds
 * 3. LOG-SCALE: continuous log normalization, same 1-34 output range
 */

// ── Fibonacci scale ──────────────────────────────────────────────
const FIB_SCALE = [1, 2, 3, 5, 8, 13, 21, 34] as const

// ── User settings (example: Czech real estate agent) ─────────────
const LOW_VALUE = 500_000    // "small deal" in CZK → maps to Fib 2
const HIGH_VALUE = 5_000_000 // "big deal" in CZK → maps to Fib 13
const OFFER_MULTIPLIER = 1.5 // seller deal

// ── Test deals ───────────────────────────────────────────────────
const TEST_DEALS = [
  { label: 'Tiny (50K)',       dollarValue: 50_000 },
  { label: 'Small (200K)',     dollarValue: 200_000 },
  { label: 'Low anchor (500K)', dollarValue: 500_000 },
  { label: 'Below avg (800K)', dollarValue: 800_000 },
  { label: 'Average (1.5M)',   dollarValue: 1_500_000 },
  { label: 'Above avg (3M)',   dollarValue: 3_000_000 },
  { label: 'High anchor (5M)', dollarValue: 5_000_000 },
  { label: 'Big (10M)',        dollarValue: 10_000_000 },
  { label: 'Huge (25M)',       dollarValue: 25_000_000 },
  { label: 'Mega (50M)',       dollarValue: 50_000_000 },
]

// ── Scoring contexts (urgency × pain × daysIgnored × weight) ────
const CONTEXTS = [
  { label: 'Fresh routine',   urgency: 3, painFactor: 2, daysIgnored: 0, weight: 10 },
  { label: 'Urgent hot lead', urgency: 8, painFactor: 5, daysIgnored: 1, weight: 30 },
  { label: 'Legal deadline',  urgency: 9, painFactor: 3, daysIgnored: 0, weight: 90 },
  { label: 'Ignored 5 days',  urgency: 5, painFactor: 7, daysIgnored: 5, weight: 20 },
]

// =====================================================================
// APPROACH 1: Current system (dollarValue / kcFactor)
// =====================================================================
function currentNormalize(dollarValue: number, kcFactor: number = 13): number {
  return dollarValue / kcFactor
}

// =====================================================================
// APPROACH 2: Fibonacci bucketing
// =====================================================================
function fibonacciNormalize(
  dollarValue: number,
  lowValue: number,
  highValue: number,
): number {
  // Fib indices: lowValue → index 1 (Fib 2), highValue → index 5 (Fib 13)
  const LOW_FIB_IDX = 1  // FIB_SCALE[1] = 2
  const HIGH_FIB_IDX = 5 // FIB_SCALE[5] = 13

  // Map value to a continuous position on the Fibonacci index scale using log
  const logLow = Math.log(lowValue)
  const logHigh = Math.log(highValue)
  const logVal = Math.log(Math.max(dollarValue, 1)) // avoid log(0)

  // Linear interpolation in log space → continuous Fib index
  const continuousIdx = LOW_FIB_IDX +
    ((logVal - logLow) / (logHigh - logLow)) * (HIGH_FIB_IDX - LOW_FIB_IDX)

  // Clamp to valid index range and snap to nearest Fibonacci
  const clampedIdx = Math.max(0, Math.min(FIB_SCALE.length - 1, Math.round(continuousIdx)))
  return FIB_SCALE[clampedIdx]
}

// =====================================================================
// APPROACH 3: Continuous log-scale (same 1-34 range, no cliffs)
// =====================================================================
function logNormalize(
  dollarValue: number,
  lowValue: number,
  highValue: number,
): number {
  const logLow = Math.log(lowValue)
  const logHigh = Math.log(highValue)
  const logVal = Math.log(Math.max(dollarValue, 1))

  // Map: lowValue→2, highValue→13, extrapolate beyond
  const normalized = 2 + ((logVal - logLow) / (logHigh - logLow)) * (13 - 2)

  // Soft clamp: allow 1-34 range (matching Fib scale extremes)
  return Math.max(1, Math.min(34, normalized))
}

// =====================================================================
// Full priority score (same formula, different normalization)
// =====================================================================
function priorityScore(
  normalizedValue: number,
  offerMultiplier: number,
  urgency: number,
  painFactor: number,
  daysIgnored: number,
  weight: number,
): number {
  const adjustedValue = normalizedValue * offerMultiplier
  const valueComponent = adjustedValue * urgency
  const painComponent = painFactor * Math.pow(daysIgnored + 1, 2)
  return Math.round(valueComponent + painComponent + weight)
}

// =====================================================================
// Run comparison
// =====================================================================

console.log('='.repeat(100))
console.log('PRIORITY SCORING PROTOTYPE — 3 Normalization Approaches')
console.log(`Low anchor: ${(LOW_VALUE / 1e6).toFixed(1)}M CZK → Fib 2 | High anchor: ${(HIGH_VALUE / 1e6).toFixed(1)}M CZK → Fib 13`)
console.log(`Offer multiplier: ${OFFER_MULTIPLIER}x (seller deal)`)
console.log('='.repeat(100))

// ── Table 1: Raw normalization values ────────────────────────────
console.log('\n📊 TABLE 1: Normalized value (before urgency/pain/weight)')
console.log('-'.repeat(85))
console.log(
  'Deal'.padEnd(22),
  'CZK'.padStart(12),
  '│',
  'Current(/13)'.padStart(12),
  'Fibonacci'.padStart(10),
  'Log-scale'.padStart(10),
  '│',
  'Fib cliff?'
)
console.log('-'.repeat(85))

for (const deal of TEST_DEALS) {
  const cur = currentNormalize(deal.dollarValue)
  const fib = fibonacciNormalize(deal.dollarValue, LOW_VALUE, HIGH_VALUE)
  const log = logNormalize(deal.dollarValue, LOW_VALUE, HIGH_VALUE)

  // Detect if this deal is near a Fibonacci boundary (within 10%)
  const logLow = Math.log(LOW_VALUE)
  const logHigh = Math.log(HIGH_VALUE)
  const continuousIdx = 1 + ((Math.log(deal.dollarValue) - logLow) / (logHigh - logLow)) * 4
  const fractional = continuousIdx - Math.round(continuousIdx)
  const nearCliff = Math.abs(fractional) > 0.35 && Math.abs(fractional) < 0.5

  console.log(
    deal.label.padEnd(22),
    deal.dollarValue.toLocaleString().padStart(12),
    '│',
    cur.toFixed(0).padStart(12),
    String(fib).padStart(10),
    log.toFixed(1).padStart(10),
    '│',
    nearCliff ? '⚠️  near boundary' : ''
  )
}

// ── Table 2: Full scores in different contexts ───────────────────
for (const ctx of CONTEXTS) {
  console.log(`\n📊 CONTEXT: "${ctx.label}" (urg=${ctx.urgency} pain=${ctx.painFactor} days=${ctx.daysIgnored} wt=${ctx.weight})`)
  console.log('-'.repeat(85))
  console.log(
    'Deal'.padEnd(22),
    '│',
    'Current'.padStart(10),
    'Fibonacci'.padStart(10),
    'Log-scale'.padStart(10),
    '│',
    'Cur vs Fib'.padStart(10),
    'Cur vs Log'.padStart(10),
  )
  console.log('-'.repeat(85))

  for (const deal of TEST_DEALS) {
    const cur = priorityScore(
      currentNormalize(deal.dollarValue),
      OFFER_MULTIPLIER, ctx.urgency, ctx.painFactor, ctx.daysIgnored, ctx.weight
    )
    const fib = priorityScore(
      fibonacciNormalize(deal.dollarValue, LOW_VALUE, HIGH_VALUE),
      OFFER_MULTIPLIER, ctx.urgency, ctx.painFactor, ctx.daysIgnored, ctx.weight
    )
    const log = priorityScore(
      logNormalize(deal.dollarValue, LOW_VALUE, HIGH_VALUE),
      OFFER_MULTIPLIER, ctx.urgency, ctx.painFactor, ctx.daysIgnored, ctx.weight
    )

    console.log(
      deal.label.padEnd(22),
      '│',
      cur.toLocaleString().padStart(10),
      fib.toLocaleString().padStart(10),
      log.toLocaleString().padStart(10),
      '│',
      `${(cur / Math.max(fib, 1)).toFixed(0)}x`.padStart(10),
      `${(cur / Math.max(log, 1)).toFixed(0)}x`.padStart(10),
    )
  }
}

// ── Table 3: Does context matter? (ratio of biggest to smallest score) ──
console.log('\n📊 TABLE 3: Score spread (max/min ratio per approach)')
console.log('Lower = urgency/pain/weight matter MORE relative to deal size')
console.log('-'.repeat(60))

for (const ctx of CONTEXTS) {
  const scores = { current: [] as number[], fibonacci: [] as number[], log: [] as number[] }

  for (const deal of TEST_DEALS) {
    scores.current.push(priorityScore(
      currentNormalize(deal.dollarValue),
      OFFER_MULTIPLIER, ctx.urgency, ctx.painFactor, ctx.daysIgnored, ctx.weight
    ))
    scores.fibonacci.push(priorityScore(
      fibonacciNormalize(deal.dollarValue, LOW_VALUE, HIGH_VALUE),
      OFFER_MULTIPLIER, ctx.urgency, ctx.painFactor, ctx.daysIgnored, ctx.weight
    ))
    scores.log.push(priorityScore(
      logNormalize(deal.dollarValue, LOW_VALUE, HIGH_VALUE),
      OFFER_MULTIPLIER, ctx.urgency, ctx.painFactor, ctx.daysIgnored, ctx.weight
    ))
  }

  const ratio = (arr: number[]) => (Math.max(...arr) / Math.max(Math.min(...arr), 1)).toFixed(0)

  console.log(
    `"${ctx.label}"`.padEnd(22),
    `Current: ${ratio(scores.current)}x`.padEnd(16),
    `Fib: ${ratio(scores.fibonacci)}x`.padEnd(12),
    `Log: ${ratio(scores.log)}x`
  )
}

// ── Table 4: Can urgency override deal size? ─────────────────────
console.log('\n📊 TABLE 4: Can a small urgent deal beat a big routine deal?')
console.log('Small=500K urg=9 pain=8 days=3 wt=50  vs  Big=5M urg=2 pain=1 days=0 wt=5')
console.log('-'.repeat(60))

const smallUrgent = { dollarValue: 500_000, urgency: 9, painFactor: 8, daysIgnored: 3, weight: 50 }
const bigRoutine = { dollarValue: 5_000_000, urgency: 2, painFactor: 1, daysIgnored: 0, weight: 5 }

for (const [name, normFn] of [
  ['Current', (v: number) => currentNormalize(v)],
  ['Fibonacci', (v: number) => fibonacciNormalize(v, LOW_VALUE, HIGH_VALUE)],
  ['Log-scale', (v: number) => logNormalize(v, LOW_VALUE, HIGH_VALUE)],
] as const) {
  const small = priorityScore(
    (normFn as (v: number) => number)(smallUrgent.dollarValue),
    OFFER_MULTIPLIER, smallUrgent.urgency, smallUrgent.painFactor, smallUrgent.daysIgnored, smallUrgent.weight
  )
  const big = priorityScore(
    (normFn as (v: number) => number)(bigRoutine.dollarValue),
    OFFER_MULTIPLIER, bigRoutine.urgency, bigRoutine.painFactor, bigRoutine.daysIgnored, bigRoutine.weight
  )
  const winner = small > big ? '✅ Small wins' : '❌ Big wins (urgency ignored)'
  console.log(`  ${name.padEnd(12)} Small=${small.toLocaleString().padStart(8)}  Big=${big.toLocaleString().padStart(8)}  ${winner}`)
}

console.log('\n' + '='.repeat(100))
console.log('KEY INSIGHT: Lower spread ratio = other factors (urgency, pain, weight) actually matter.')
console.log('Current system: deal size dominates everything. Fib & Log compress it so context matters.')
console.log('='.repeat(100))
