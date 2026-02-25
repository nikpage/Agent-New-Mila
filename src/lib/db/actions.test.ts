import { describe, it, expect } from 'vitest'
import { calculatePriorityScore } from './actions'

/**
 * Log-scale normalization helper (mirrors the implementation)
 * effectiveValue = dollarValue * offerMultiplier → log compress, no clamping
 * lowValue → 2, highValue → 13
 */
function expectedLogNorm(effectiveValue: number, low = 500_000, high = 5_000_000): number {
  if (effectiveValue <= 0) return 0
  const logLow = Math.log(low)
  const logHigh = Math.log(high)
  const logVal = Math.log(effectiveValue)
  return 2 + ((logVal - logLow) / (logHigh - logLow)) * 11
}

describe('calculatePriorityScore', () => {
  it('calculates basic score with all inputs (log-scale)', () => {
    // dollarValue=1_000_000, urgency=5, painFactor=3, daysIgnored=2
    // effectiveValue = 1_000_000 * 1 (default offerMultiplier)
    // logNorm ≈ 2 + (log(1M) - log(500K)) / (log(5M) - log(500K)) * 11 ≈ 5.31
    // valueComponent = 5.31 * 5 = 26.55
    // painComponent = 3 * (2+1)^2 = 27
    // total = round(26.55 + 27 + 0) = 54
    const norm = expectedLogNorm(1_000_000)
    const expected = Math.round(norm * 5 + 3 * Math.pow(3, 2) + 0)
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 5,
      painFactor: 3,
      daysIgnored: 2,
    })
    expect(score).toBe(expected)
  })

  it('applies offerMultiplier BEFORE log normalization', () => {
    // 3M × 1.5 = 4.5M effective → should score near a raw 4.5M deal
    const withMultiplier = calculatePriorityScore({
      dollarValue: 3_000_000,
      urgency: 5,
      painFactor: 1,
      daysIgnored: 0,
      offerMultiplier: 1.5,
    })
    // Compare: 4.5M raw deal, no multiplier
    const rawEquivalent = calculatePriorityScore({
      dollarValue: 4_500_000,
      urgency: 5,
      painFactor: 1,
      daysIgnored: 0,
      offerMultiplier: 1.0,
    })
    expect(withMultiplier).toBe(rawEquivalent)
  })

  it('includes weight in final score', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 1,
      painFactor: 1,
      daysIgnored: 0,
      weight: 100,
    })
    // dollarValue=0 → normalizedValue=0, valueComponent=0
    // painComponent = 1 * 1 = 1, weight = 100
    expect(score).toBe(101)
  })

  it('replaces zero urgency with 1 to prevent score collapse', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 0,
      painFactor: 1,
      daysIgnored: 0,
    })
    // urgency 0 → 1: norm * 1 + 1 * 1 + 0
    const norm = expectedLogNorm(1_000_000)
    expect(score).toBe(Math.round(norm * 1 + 1 + 0))
  })

  it('replaces zero painFactor with 1', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 1,
      painFactor: 0,
      daysIgnored: 3,
    })
    // painFactor 0 → 1: 0 + 1 * (3+1)^2 + 0 = 16
    expect(score).toBe(16)
  })

  it('replaces zero offerMultiplier with 1', () => {
    const withZero = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 2,
      painFactor: 1,
      daysIgnored: 0,
      offerMultiplier: 0,
    })
    const withDefault = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 2,
      painFactor: 1,
      daysIgnored: 0,
      offerMultiplier: 1,
    })
    // Zero → falls back to 1
    expect(withZero).toBe(withDefault)
  })

  it('daysIgnored growth is quadratic', () => {
    const score0 = calculatePriorityScore({ dollarValue: 0, urgency: 1, painFactor: 5, daysIgnored: 0 })
    const score5 = calculatePriorityScore({ dollarValue: 0, urgency: 1, painFactor: 5, daysIgnored: 5 })
    const score10 = calculatePriorityScore({ dollarValue: 0, urgency: 1, painFactor: 5, daysIgnored: 10 })

    // 5 * 1^2 = 5,  5 * 6^2 = 180,  5 * 11^2 = 605
    expect(score0).toBe(5)
    expect(score5).toBe(180)
    expect(score10).toBe(605)
    // Quadratic: growth from 0→5 < growth from 5→10
    expect(score10 - score5).toBeGreaterThan(score5 - score0)
  })

  it('returns a rounded integer', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_500_000,
      urgency: 3,
      painFactor: 7,
      daysIgnored: 1,
      offerMultiplier: 1.5,
    })
    expect(Number.isInteger(score)).toBe(true)
  })

  it('handles all-zero inputs gracefully (no NaN, no crash)', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 0,
      painFactor: 0,
      daysIgnored: 0,
    })
    // All zeros → safe defaults: normalizedValue=0, painFactor→1: 0 + 1*1 + 0 = 1
    expect(score).toBe(1)
    expect(Number.isFinite(score)).toBe(true)
  })

  // ── Log-scale normalization behavior ────────────────────────────────

  it('low anchor value maps to normalized ~2', () => {
    const score = calculatePriorityScore({
      dollarValue: 500_000,  // = kcLowValue default
      urgency: 1,
      painFactor: 0,
      daysIgnored: 0,
    })
    // normalizedValue ≈ 2, painFactor→1: 2*1 + 1*1 + 0 = 3
    expect(score).toBe(Math.round(2 * 1 + 1))
  })

  it('high anchor value maps to normalized ~13', () => {
    const score = calculatePriorityScore({
      dollarValue: 5_000_000,  // = kcHighValue default
      urgency: 1,
      painFactor: 0,
      daysIgnored: 0,
    })
    // normalizedValue = 13, painFactor→1: 13*1 + 1*1 + 0 = 14
    expect(score).toBe(Math.round(13 * 1 + 1))
  })

  it('values above high anchor extend beyond 13 with no cap', () => {
    const bigDeal = calculatePriorityScore({
      dollarValue: 50_000_000,
      urgency: 1,
      painFactor: 0,
      daysIgnored: 0,
    })
    const hugeDeal = calculatePriorityScore({
      dollarValue: 500_000_000_000, // absurdly large
      urgency: 1,
      painFactor: 0,
      daysIgnored: 0,
    })
    // Big deal scores > 13 (the high anchor)
    const norm50M = expectedLogNorm(50_000_000)
    expect(norm50M).toBeGreaterThan(13)
    expect(bigDeal).toBe(Math.round(norm50M + 1))
    // Huge deal scores even higher — no cap
    const normHuge = expectedLogNorm(500_000_000_000)
    expect(hugeDeal).toBe(Math.round(normHuge + 1))
    expect(hugeDeal).toBeGreaterThan(bigDeal)
  })

  it('values below low anchor go below 2 with no floor', () => {
    const tinyDeal = calculatePriorityScore({
      dollarValue: 10_000,
      urgency: 1,
      painFactor: 0,
      daysIgnored: 0,
    })
    const normTiny = expectedLogNorm(10_000)
    // 10K is far below the 500K low anchor — normalizedValue goes negative
    expect(normTiny).toBeLessThan(0)
    expect(tinyDeal).toBe(Math.round(normTiny + 1))
  })

  it('dollarValue=0 produces zero value component', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 10,
      painFactor: 5,
      daysIgnored: 3,
      weight: 8,
    })
    // normalizedValue = 0 (no financial component)
    // 0*10 + 5*(3+1)^2 + 8 = 0 + 80 + 8 = 88
    expect(score).toBe(88)
  })

  it('custom kcLowValue/kcHighValue shift the normalization anchors', () => {
    // With custom anchors: low=100K, high=1M
    // 500K should be near the high end (normalized ~11)
    const customAnchors = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 1,
      painFactor: 0,
      daysIgnored: 0,
      kcLowValue: 100_000,
      kcHighValue: 1_000_000,
    })
    // Same deal with default anchors: 500K is the low anchor (normalized = 2)
    const defaultAnchors = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 1,
      painFactor: 0,
      daysIgnored: 0,
    })
    // With tighter anchors, 500K scores much higher
    expect(customAnchors).toBeGreaterThan(defaultAnchors)
  })

  it('kcLowValue=0 falls back to safe default', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 1,
      painFactor: 1,
      daysIgnored: 0,
      kcLowValue: 0,
    })
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThan(0)
  })

  it('kcHighValue <= kcLowValue falls back to safeLow * 10', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 1,
      painFactor: 1,
      daysIgnored: 0,
      kcLowValue: 500_000,
      kcHighValue: 500_000, // same as low — would cause log(1) = 0 division
    })
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThan(0)
  })

  // ── Score spread: deal size doesn't dominate ────────────────────────

  it('urgent small deal beats routine big deal', () => {
    const smallUrgent = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 9,
      painFactor: 8,
      daysIgnored: 3,
      weight: 8,
    })
    const bigRoutine = calculatePriorityScore({
      dollarValue: 5_000_000,
      urgency: 2,
      painFactor: 1,
      daysIgnored: 0,
      weight: 2,
    })
    expect(smallUrgent).toBeGreaterThan(bigRoutine)
  })
})
