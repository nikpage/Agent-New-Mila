import { describe, it, expect } from 'vitest'
import { scoreWalkerOutput } from './scoring-engine'
import type { GraphWalkerOutput, WalkerTask } from './graph-walker'
import type { UserSettings, Deal } from '@/lib/supabase/types'

const SETTINGS: UserSettings = {
  kc_high_value: 10_000_000,
  offer_multiplier_seller: 1.5,
  offer_multiplier_buyer: 1.0,
  cooling_threshold_days: 7,
  cold_threshold_days: 14,
  dead_threshold_days: 30,
} as UserSettings

const PAST_DAYS = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()

const DEAL = (id: string, overrides?: Partial<Deal>): Deal => ({
  id,
  user_id: 'user-1',
  title: 'Test deal',
  status: 'active',
  category: 'business',
  user_role: 'seller',
  deal_type: 'sale',
  parent_deal_id: null,
  potential_merge_with: null,
  anomaly_boost: 0,
  last_activity_at: PAST_DAYS(1),
  last_processed_at: null,
  created_at: PAST_DAYS(30),
  ...overrides,
})

const TASK = (dealId: string, overrides?: Partial<WalkerTask>): WalkerTask => ({
  nodeId: 'node-1',
  dealId,
  taskType: 'blocking',
  deadline: null,
  hoursUntilDue: null,
  slack: null,
  cpId: null,
  entityMapSnapshot: {},
  beliefSnapshot: [],
  ...overrides,
})

const OUTPUT = (deal: Deal, tasks: WalkerTask[]): GraphWalkerOutput => ({
  dealId: deal.id,
  deal,
  tasks,
})

describe('scoreWalkerOutput — basic ranking', () => {
  it('returns scored tasks sorted by score descending', () => {
    const output = OUTPUT(DEAL('d1'), [
      TASK('d1', { taskType: 'has_slack' }),
      TASK('d1', { taskType: 'overdue' }),
    ])

    const result = scoreWalkerOutput([output], SETTINGS)
    expect(result[0].taskType).toBe('overdue')
    expect(result[1].taskType).toBe('has_slack')
  })

  it('high-value deal outranks low-value deal at same urgency', () => {
    const highValue = OUTPUT(DEAL('d-high'), [
      TASK('d-high', {
        taskType: 'blocking',
        entityMapSnapshot: { 'price.asking_price': '50 000 000 Kč' },
      }),
    ])
    const lowValue = OUTPUT(DEAL('d-low'), [
      TASK('d-low', {
        taskType: 'blocking',
        entityMapSnapshot: { 'price.asking_price': '2 000 000 Kč' },
      }),
    ])

    const result = scoreWalkerOutput([highValue, lowValue], SETTINGS)
    expect(result[0].dealId).toBe('d-high')
    expect(result[1].dealId).toBe('d-low')
  })

  it('overdue task outranks has_slack even for low-value deal', () => {
    const highSlack = OUTPUT(DEAL('d-slack', { last_activity_at: PAST_DAYS(0) }), [
      TASK('d-slack', {
        taskType: 'has_slack',
        entityMapSnapshot: { 'price.asking_price': '50 000 000 Kč' },
      }),
    ])
    const lowOverdue = OUTPUT(DEAL('d-overdue', { last_activity_at: PAST_DAYS(10) }), [
      TASK('d-overdue', {
        taskType: 'overdue',
        entityMapSnapshot: { 'price.asking_price': '1 000 000 Kč' },
      }),
    ])

    const result = scoreWalkerOutput([highSlack, lowOverdue], SETTINGS)
    expect(result[0].dealId).toBe('d-overdue')
  })
})

describe('scoreWalkerOutput — score breakdown', () => {
  it('includes score breakdown with all terms', () => {
    const output = OUTPUT(DEAL('d1'), [TASK('d1')])
    const result = scoreWalkerOutput([output], SETTINGS)
    const breakdown = result[0].scoreBreakdown

    expect(typeof breakdown.dealImportance).toBe('number')
    expect(typeof breakdown.timePressure).toBe('number')
    expect(typeof breakdown.graphPressure).toBe('number')
    expect(typeof breakdown.immovability).toBe('number')
    expect(typeof breakdown.anomalyBoost).toBe('number')
  })

  it('anomaly_boost is added to score', () => {
    const normalDeal = DEAL('d-normal', { anomaly_boost: 0 })
    const anomalyDeal = DEAL('d-anomaly', { anomaly_boost: 50 })

    const result = scoreWalkerOutput([
      OUTPUT(normalDeal, [TASK('d-normal')]),
      OUTPUT(anomalyDeal, [TASK('d-anomaly')]),
    ], SETTINGS)

    const normalScore = result.find(t => t.dealId === 'd-normal')!.score
    const anomalyScore = result.find(t => t.dealId === 'd-anomaly')!.score
    expect(anomalyScore).toBeGreaterThan(normalScore)
    expect(anomalyScore - normalScore).toBeCloseTo(50, 0)
  })

  it('seller gets higher score than buyer for same deal value', () => {
    const sellerDeal = DEAL('d-seller', { user_role: 'seller' })
    const buyerDeal  = DEAL('d-buyer',  { user_role: 'buyer' })

    const entityMap = { 'price.asking_price': '5 000 000 Kč' }
    const result = scoreWalkerOutput([
      OUTPUT(sellerDeal, [TASK('d-seller', { entityMapSnapshot: entityMap })]),
      OUTPUT(buyerDeal,  [TASK('d-buyer',  { entityMapSnapshot: entityMap })]),
    ], SETTINGS)

    const sellerScore = result.find(t => t.dealId === 'd-seller')!.scoreBreakdown.dealImportance
    const buyerScore  = result.find(t => t.dealId === 'd-buyer')!.scoreBreakdown.dealImportance
    expect(sellerScore).toBeGreaterThan(buyerScore)
  })

  it('graphPressure is non-zero for blocking/overdue tasks', () => {
    const result = scoreWalkerOutput([
      OUTPUT(DEAL('d1'), [TASK('d1', { taskType: 'blocking' })]),
    ], SETTINGS)
    expect(result[0].scoreBreakdown.graphPressure).toBeGreaterThan(0)
  })

  it('graphPressure is zero for has_slack tasks', () => {
    const result = scoreWalkerOutput([
      OUTPUT(DEAL('d1'), [TASK('d1', { taskType: 'has_slack' })]),
    ], SETTINGS)
    expect(result[0].scoreBreakdown.graphPressure).toBe(0)
  })
})

describe('scoreWalkerOutput — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(scoreWalkerOutput([], SETTINGS)).toHaveLength(0)
  })

  it('handles deal with no entity map (zero dollar value)', () => {
    const result = scoreWalkerOutput([
      OUTPUT(DEAL('d1'), [TASK('d1')]),
    ], SETTINGS)
    // nVal floor is 1, so dealImportance >= 1
    expect(result[0].scoreBreakdown.dealImportance).toBeGreaterThanOrEqual(1)
  })

  it('daysIgnored amplifies timePressure for stale deals', () => {
    const fresh = DEAL('d-fresh', { last_activity_at: PAST_DAYS(1) })
    const stale = DEAL('d-stale', { last_activity_at: PAST_DAYS(20) })

    const result = scoreWalkerOutput([
      OUTPUT(fresh, [TASK('d-fresh', { taskType: 'blocking' })]),
      OUTPUT(stale, [TASK('d-stale', { taskType: 'blocking' })]),
    ], SETTINGS)

    const freshPressure = result.find(t => t.dealId === 'd-fresh')!.scoreBreakdown.timePressure
    const stalePressure = result.find(t => t.dealId === 'd-stale')!.scoreBreakdown.timePressure
    expect(stalePressure).toBeGreaterThan(freshPressure)
  })
})
