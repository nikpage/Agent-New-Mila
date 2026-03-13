import { describe, it, expect } from 'vitest'
import { calculatePriorityScore } from './actions'

describe('calculatePriorityScore', () => {
  it('calculates basic score with all inputs (log-scale)', () => {
    // dollarValue=1_000_000, urgency=5, daysIgnored=2
    // normVal = log_compress(1M) ≈ 5.31, score = 5.31 + 5 + 4 + 0 → 14
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 5,
      daysIgnored: 2,
    })
    expect(score).toBe(14)
  })

  it('applies sellerMultiplier AFTER log normalization', () => {
    // 3M with 1.5x multiplier: log_compress(3M) ≈ 10.56, × 1.5 = 15.84
    // score = 15.84 + 5 + 0 + 0 → 21
    const withMultiplier = calculatePriorityScore({
      dollarValue: 3_000_000,
      urgency: 5,
      daysIgnored: 0,
      sellerMultiplier: 1.5,
    })
    expect(withMultiplier).toBe(21)
  })

  it('includes weight in final score', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 1,
      daysIgnored: 0,
      weight: 100,
    })
    // normVal=0, U→1, days²=0, W=100 → 0 + 1 + 0 + 100 = 101
    expect(score).toBe(101)
  })

  it('replaces zero urgency with 1 to prevent score collapse', () => {
    // urgency 0 → 1: log_compress(1M) ≈ 5.31 + 1 → 6
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 0,
      daysIgnored: 0,
    })
    expect(score).toBe(6)
  })

  it('replaces zero sellerMultiplier with 1', () => {
    const withZero = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 2,
      daysIgnored: 0,
      sellerMultiplier: 0,
    })
    const withDefault = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 2,
      daysIgnored: 0,
      sellerMultiplier: 1,
    })
    // Zero → falls back to 1
    expect(withZero).toBe(withDefault)
  })

  it('daysIgnored growth is quadratic', () => {
    const score0 = calculatePriorityScore({ dollarValue: 0, urgency: 1, daysIgnored: 0 })
    const score5 = calculatePriorityScore({ dollarValue: 0, urgency: 1, daysIgnored: 5 })
    const score10 = calculatePriorityScore({ dollarValue: 0, urgency: 1, daysIgnored: 10 })

    // normVal=0, U=1: score = 0 + 1 + days² + 0
    // day 0: 1, day 5: 1+25=26, day 10: 1+100=101
    expect(score0).toBe(1)
    expect(score5).toBe(26)
    expect(score10).toBe(101)
    // Quadratic: growth from 0→5 < growth from 5→10
    expect(score10 - score5).toBeGreaterThan(score5 - score0)
  })

  it('returns a rounded integer', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_500_000,
      urgency: 3,
      daysIgnored: 1,
      sellerMultiplier: 1.5,
    })
    expect(Number.isInteger(score)).toBe(true)
  })

  it('handles all-zero inputs gracefully (no NaN, no crash)', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 0,
      daysIgnored: 0,
    })
    // All zeros → safe defaults: normVal=0, urgency→1: 0 + 1 + 0 + 0 = 1
    expect(score).toBe(1)
    expect(Number.isFinite(score)).toBe(true)
  })

  // ── Log-scale normalization behavior ────────────────────────────────

  it('low anchor value maps to normalized ~2', () => {
    const score = calculatePriorityScore({
      dollarValue: 500_000,  // = kcLowValue default
      urgency: 1,
      daysIgnored: 0,
    })
    // normVal = 2, score = 2 + 1 + 0 + 0 = 3
    expect(score).toBe(3)
  })

  it('high anchor value maps to normalized ~13', () => {
    const score = calculatePriorityScore({
      dollarValue: 5_000_000,  // = kcHighValue default
      urgency: 1,
      daysIgnored: 0,
    })
    // normVal = 13, score = 13 + 1 + 0 + 0 = 14
    expect(score).toBe(14)
  })

  it('values above high anchor extend beyond 13 with no cap', () => {
    const bigDeal = calculatePriorityScore({
      dollarValue: 50_000_000,
      urgency: 1,
      daysIgnored: 0,
    })
    const hugeDeal = calculatePriorityScore({
      dollarValue: 500_000_000_000, // absurdly large
      urgency: 1,
      daysIgnored: 0,
    })
    // 50M → score 25, 500B → score 69
    expect(bigDeal).toBe(25)
    expect(hugeDeal).toBe(69)
    expect(hugeDeal).toBeGreaterThan(bigDeal)
  })

  it('values below low anchor go below 2 with no floor', () => {
    const tinyDeal = calculatePriorityScore({
      dollarValue: 10_000,
      urgency: 1,
      daysIgnored: 0,
    })
    // 10K is far below 500K low anchor → normVal negative → score -16
    expect(tinyDeal).toBe(-16)
  })

  it('dollarValue=0 produces zero value component', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 10,
      daysIgnored: 3,
      weight: 8,
    })
    // normVal = 0, score = 0 + 10 + 9 + 8 = 27
    expect(score).toBe(27)
  })

  it('custom kcLowValue/kcHighValue shift the normalization anchors', () => {
    // With custom anchors: low=100K, high=1M
    // 500K should be near the high end (normalized ~11)
    const customAnchors = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 1,
      daysIgnored: 0,
      kcLowValue: 100_000,
      kcHighValue: 1_000_000,
    })
    // Same deal with default anchors: 500K is the low anchor (normalized = 2)
    const defaultAnchors = calculatePriorityScore({
      dollarValue: 500_000,
      urgency: 1,
      daysIgnored: 0,
    })
    // With tighter anchors, 500K scores much higher
    expect(customAnchors).toBeGreaterThan(defaultAnchors)
  })

  it('kcLowValue=0 falls back to safe default', () => {
    const score = calculatePriorityScore({
      dollarValue: 1_000_000,
      urgency: 1,
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
      daysIgnored: 3,
      weight: 8,
    })
    const bigRoutine = calculatePriorityScore({
      dollarValue: 5_000_000,
      urgency: 2,
      daysIgnored: 0,
      weight: 2,
    })
    expect(smallUrgent).toBeGreaterThan(bigRoutine)
  })
})
