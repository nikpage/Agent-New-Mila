import { describe, it, expect } from 'vitest'
import { calculatePriorityScore } from './actions'

describe('calculatePriorityScore', () => {
  it('calculates basic score with all inputs', () => {
    const score = calculatePriorityScore({
      dollarValue: 1000,
      urgency: 5,
      painFactor: 3,
      daysIgnored: 2,
    })
    // (1000 * 1 * 5) + (3 * (2+1)^2) + 0 = 5000 + 27 + 0 = 5027
    expect(score).toBe(5027)
  })

  it('applies offerMultiplier to dollar value', () => {
    const score = calculatePriorityScore({
      dollarValue: 1000,
      urgency: 5,
      painFactor: 3,
      daysIgnored: 0,
      offerMultiplier: 1.5,
    })
    // (1000 * 1.5 * 5) + (3 * 1) + 0 = 7500 + 3 + 0 = 7503
    expect(score).toBe(7503)
  })

  it('includes weight in final score', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 1,
      painFactor: 1,
      daysIgnored: 0,
      weight: 100,
    })
    // (0 * 1 * 1) + (1 * 1) + 100 = 0 + 1 + 100 = 101
    expect(score).toBe(101)
  })

  it('replaces zero urgency with 1 to prevent score collapse', () => {
    const score = calculatePriorityScore({
      dollarValue: 1000,
      urgency: 0,
      painFactor: 1,
      daysIgnored: 0,
    })
    // urgency 0 → 1: (1000 * 1 * 1) + (1 * 1) + 0 = 1001
    expect(score).toBe(1001)
  })

  it('replaces zero painFactor with 1', () => {
    const score = calculatePriorityScore({
      dollarValue: 0,
      urgency: 1,
      painFactor: 0,
      daysIgnored: 3,
    })
    // painFactor 0 → 1: (0) + (1 * (3+1)^2) + 0 = 16
    expect(score).toBe(16)
  })

  it('replaces zero offerMultiplier with 1', () => {
    const score = calculatePriorityScore({
      dollarValue: 500,
      urgency: 2,
      painFactor: 1,
      daysIgnored: 0,
      offerMultiplier: 0,
    })
    // offerMultiplier 0 → 1: (500 * 1 * 2) + (1 * 1) + 0 = 1001
    expect(score).toBe(1001)
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
      dollarValue: 333,
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
    // All zeros → safe defaults: (0 / 1 * 1 * 1) + (1 * 1) + 0 = 1
    expect(score).toBe(1)
    expect(Number.isFinite(score)).toBe(true)
  })

  it('applies kcFactor to normalize dollar value', () => {
    const score = calculatePriorityScore({
      dollarValue: 5_000_000,
      urgency: 5,
      painFactor: 1,
      daysIgnored: 0,
      kcFactor: 13,
    })
    // (5_000_000 / 13 * 1 * 5) + (1 * 1) + 0 ≈ 1_923_077
    expect(score).toBe(Math.round((5_000_000 / 13) * 5 + 1))
  })

  it('kcFactor=1 is identity (no normalization)', () => {
    const withKc = calculatePriorityScore({
      dollarValue: 1000,
      urgency: 5,
      painFactor: 3,
      daysIgnored: 2,
      kcFactor: 1,
    })
    const withoutKc = calculatePriorityScore({
      dollarValue: 1000,
      urgency: 5,
      painFactor: 3,
      daysIgnored: 2,
    })
    expect(withKc).toBe(withoutKc)
  })

  it('replaces zero kcFactor with 1 to prevent division by zero', () => {
    const score = calculatePriorityScore({
      dollarValue: 1000,
      urgency: 1,
      painFactor: 1,
      daysIgnored: 0,
      kcFactor: 0,
    })
    // kcFactor 0 → 1: (1000 / 1 * 1 * 1) + (1 * 1) + 0 = 1001
    expect(score).toBe(1001)
    expect(Number.isFinite(score)).toBe(true)
  })

  it('higher kcFactor reduces dollar value impact', () => {
    const lowKc = calculatePriorityScore({
      dollarValue: 5_000_000,
      urgency: 5,
      painFactor: 1,
      daysIgnored: 0,
      kcFactor: 8,
    })
    const highKc = calculatePriorityScore({
      dollarValue: 5_000_000,
      urgency: 5,
      painFactor: 1,
      daysIgnored: 0,
      kcFactor: 21,
    })
    expect(lowKc).toBeGreaterThan(highKc)
  })
})
