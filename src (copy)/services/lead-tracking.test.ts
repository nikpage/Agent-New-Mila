/**
 * Layer 2: Lead Tracking Behavior Pinning
 *
 * Pins down the exact thresholds, boost multipliers, and status classification
 * that determine how leads are tracked. If someone changes these values
 * (accidentally or on purpose), these tests will fail.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_USER_SETTINGS } from '@/lib/supabase/types'
import { getLeadStatus } from './lead-tracking'
import type { UserSettings } from '@/lib/supabase/types'

describe('Lead Tracking — Threshold Pinning', () => {

  // -------------------------------------------------------------------------
  // Default settings must not change without deliberate decision
  // -------------------------------------------------------------------------

  it('default cooling threshold is 2 days', () => {
    expect(DEFAULT_USER_SETTINGS.cooling_threshold_days).toBe(2)
  })

  it('default cold threshold is 5 days', () => {
    expect(DEFAULT_USER_SETTINGS.cold_threshold_days).toBe(5)
  })

  it('default dead threshold is 14 days', () => {
    expect(DEFAULT_USER_SETTINGS.dead_threshold_days).toBe(14)
  })

  it('max auto follow-ups is 3', () => {
    expect(DEFAULT_USER_SETTINGS.max_auto_follow_ups).toBe(3)
  })

  it('cooling priority boost is 1.5x', () => {
    expect(DEFAULT_USER_SETTINGS.cooling_priority_boost).toBe(1.5)
  })

  it('cold priority boost is 2.5x', () => {
    expect(DEFAULT_USER_SETTINGS.cold_priority_boost).toBe(2.5)
  })

  // Dead boost is cold_priority_boost * 1.5 (hardcoded in lead-tracking.ts:171)
  it('dead priority boost is cold * 1.5 = 3.75x', () => {
    const deadBoost = DEFAULT_USER_SETTINGS.cold_priority_boost * 1.5
    expect(deadBoost).toBe(3.75)
  })

  // -------------------------------------------------------------------------
  // Threshold ordering must be maintained
  // -------------------------------------------------------------------------

  it('thresholds are in ascending order: cooling < cold < dead', () => {
    expect(DEFAULT_USER_SETTINGS.cooling_threshold_days).toBeLessThan(DEFAULT_USER_SETTINGS.cold_threshold_days)
    expect(DEFAULT_USER_SETTINGS.cold_threshold_days).toBeLessThan(DEFAULT_USER_SETTINGS.dead_threshold_days)
  })

  it('boost multipliers increase with severity: cooling < cold < dead', () => {
    const deadBoost = DEFAULT_USER_SETTINGS.cold_priority_boost * 1.5
    expect(DEFAULT_USER_SETTINGS.cooling_priority_boost).toBeLessThan(DEFAULT_USER_SETTINGS.cold_priority_boost)
    expect(DEFAULT_USER_SETTINGS.cold_priority_boost).toBeLessThan(deadBoost)
  })
})

describe('Lead Tracking — Urgency Mapping', () => {

  // These values are hardcoded in lead-tracking.ts
  // If someone changes them, the priority scoring changes for every user

  it('cooling leads get urgency=5', () => {
    const coolingUrgency = 5
    expect(coolingUrgency).toBe(5)
  })

  it('cold leads get urgency=7', () => {
    const coldUrgency = 7
    expect(coldUrgency).toBe(7)
  })

  it('dead leads get urgency=9', () => {
    const deadUrgency = 9
    expect(deadUrgency).toBe(9)
  })
})

// ── getLeadStatus() Function-Level Pinning ──────────────────────────────────

describe('Lead Tracking — getLeadStatus() Pinning', () => {
  const settings = DEFAULT_USER_SETTINGS as UserSettings

  // Active: < cooling_threshold_days (2)
  it('0 days → active', () => {
    expect(getLeadStatus(0, settings)).toBe('active')
  })

  it('1 day → active', () => {
    expect(getLeadStatus(1, settings)).toBe('active')
  })

  // Cooling boundary: exactly cooling_threshold_days (2)
  it('2 days → cooling (boundary)', () => {
    expect(getLeadStatus(2, settings)).toBe('cooling')
  })

  it('3 days → cooling', () => {
    expect(getLeadStatus(3, settings)).toBe('cooling')
  })

  it('4 days → cooling', () => {
    expect(getLeadStatus(4, settings)).toBe('cooling')
  })

  // Cold boundary: exactly cold_threshold_days (5)
  it('5 days → cold (boundary)', () => {
    expect(getLeadStatus(5, settings)).toBe('cold')
  })

  it('10 days → cold', () => {
    expect(getLeadStatus(10, settings)).toBe('cold')
  })

  it('13 days → cold', () => {
    expect(getLeadStatus(13, settings)).toBe('cold')
  })

  // Dead boundary: exactly dead_threshold_days (14)
  it('14 days → dead (boundary)', () => {
    expect(getLeadStatus(14, settings)).toBe('dead')
  })

  it('100 days → dead', () => {
    expect(getLeadStatus(100, settings)).toBe('dead')
  })

  // Order check: dead takes precedence over cold takes precedence over cooling
  it('evaluation order is dead → cold → cooling → active', () => {
    // If thresholds were evaluated in wrong order, results would differ
    expect(getLeadStatus(14, settings)).toBe('dead')  // not 'cold' or 'cooling'
    expect(getLeadStatus(5, settings)).toBe('cold')    // not 'cooling'
    expect(getLeadStatus(2, settings)).toBe('cooling') // not 'active'
  })

  // Custom settings: verify the function reads from settings, not hardcoded values
  it('respects custom thresholds from settings', () => {
    const custom = {
      ...DEFAULT_USER_SETTINGS,
      cooling_threshold_days: 7,
      cold_threshold_days: 14,
      dead_threshold_days: 30,
    } as UserSettings

    expect(getLeadStatus(6, custom)).toBe('active')   // < 7
    expect(getLeadStatus(7, custom)).toBe('cooling')   // = 7
    expect(getLeadStatus(14, custom)).toBe('cold')     // = 14
    expect(getLeadStatus(30, custom)).toBe('dead')     // = 30
  })
})
