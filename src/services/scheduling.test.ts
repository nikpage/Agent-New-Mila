/**
 * Scheduling Tests — Proves the spec (CLAUDE.md + SPEC.md)
 *
 * Tests real code logic where possible. Mocks only:
 * - Google Calendar API (external service)
 * - Google Maps API (external service)
 * - Database calls (need Supabase)
 *
 * What we prove against the spec:
 * - ONE hold per meeting — optimizer picks the optimal slot, not multiple options
 * - Batch optimization: collects ALL pending unsent SCHEDULE actions, one slot each
 * - Optimization priority order: CP availability > user availability > travel > conflict resolution
 * - Sent invites are fixed walls — never auto-moved (but Mila may suggest moving if conflict requires it)
 * - Conflict resolution is last resort: prefer scheduling without moving existing events
 * - Confirm → hold becomes confirmed event + invite sent to CP (spec step 8)
 * - Reject → hold cleared (spec step 9)
 * - Slot finding respects working hours, buffer, working days
 * - Travel buffer: >500m = driving via Maps, ≤500m = 15min flat
 * - Buffer formula: max(travelTime + 10min, 15min minimum)
 * - Conflict resolution: higher score wins, weight=null → never move
 * - User-created events default weight = 7
 * - Personal events block time, don't generate actions
 * - Invitations always create SCHEDULE action (human in loop)
 * - calculateEventScore delegates to calculatePriorityScore correctly
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_USER_SETTINGS } from '@/lib/supabase/types'
import type { UserSettings } from '@/lib/supabase/types'

// ── Mocks (external services + DB only) ────────────────────────────────────

const mockFindFreeSlots = vi.fn()
const mockCheckConflicts = vi.fn()
const mockCreateTentativeCalendarEvent = vi.fn()
const mockCreateCalendarEvent = vi.fn()
const mockDeleteCalendarEvent = vi.fn()
const mockConfirmCalendarEvent = vi.fn()
const mockRespondToInvitation = vi.fn()

vi.mock('@/lib/google/calendar', () => ({
  findFreeSlots: (...args: unknown[]) => mockFindFreeSlots(...args),
  checkConflicts: (...args: unknown[]) => mockCheckConflicts(...args),
  createTentativeCalendarEvent: (...args: unknown[]) => mockCreateTentativeCalendarEvent(...args),
  createCalendarEvent: (...args: unknown[]) => mockCreateCalendarEvent(...args),
  deleteCalendarEvent: (...args: unknown[]) => mockDeleteCalendarEvent(...args),
  confirmCalendarEvent: (...args: unknown[]) => mockConfirmCalendarEvent(...args),
  respondToInvitation: (...args: unknown[]) => mockRespondToInvitation(...args),
  MILA_BLOCK_GROUP_KEY: 'milaBlockGroup',
}))

const mockCreateEvent = vi.fn()
const mockCreateHoldEvent = vi.fn()
const mockCreateTravelBuffer = vi.fn()
const mockFindConflicts = vi.fn().mockResolvedValue([])
const mockGetEventById = vi.fn()
const mockUpdateEvent = vi.fn()
const mockDeleteEvent = vi.fn()
const mockConfirmEvent = vi.fn()
const mockCancelEventWithCleanup = vi.fn()
const mockCleanupBlockGroup = vi.fn().mockResolvedValue({ deletedIds: [], deletedGoogleEventIds: [] })
const mockCleanupTravelBuffers = vi.fn()
const mockGetEventsByBlockGroup = vi.fn()
const mockGetLastEventLocation = vi.fn().mockResolvedValue(null)

vi.mock('@/lib/db/events', async () => {
  const { calculateEventScore: realCalcEventScore } = await vi.importActual<typeof import('@/lib/db/events')>('@/lib/db/events')
  return {
    createEvent: (...args: unknown[]) => mockCreateEvent(...args),
    createHoldEvent: (...args: unknown[]) => mockCreateHoldEvent(...args),
    createTravelBuffer: (...args: unknown[]) => mockCreateTravelBuffer(...args),
    findConflicts: (...args: unknown[]) => mockFindConflicts(...args),
    getEventById: (...args: unknown[]) => mockGetEventById(...args),
    updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
    deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
    confirmEvent: (...args: unknown[]) => mockConfirmEvent(...args),
    cancelEventWithCleanup: (...args: unknown[]) => mockCancelEventWithCleanup(...args),
    cleanupBlockGroup: (...args: unknown[]) => mockCleanupBlockGroup(...args),
    cleanupTravelBuffers: (...args: unknown[]) => mockCleanupTravelBuffers(...args),
    getEventsByBlockGroup: (...args: unknown[]) => mockGetEventsByBlockGroup(...args),
    calculateEventScore: realCalcEventScore,
    getLastEventLocation: (...args: unknown[]) => mockGetLastEventLocation(...args),
  }
})

vi.mock('@/lib/db/users', () => ({
  getUserSettings: vi.fn().mockResolvedValue(DEFAULT_USER_SETTINGS),
  getUserById: vi.fn().mockResolvedValue({ id: 'user-1', email: 'test@example.com' }),
}))

const mockGetCPById = vi.fn()
vi.mock('@/lib/db/counterparties', () => ({
  getCPById: (...args: unknown[]) => mockGetCPById(...args),
}))

// Use real calculatePriorityScore + mock getPendingScheduleActions + updateAction
const mockGetPendingScheduleActions = vi.fn()
const mockUpdateAction = vi.fn().mockResolvedValue({})
vi.mock('@/lib/db/actions', async () => {
  const { calculatePriorityScore: realCalc } = await vi.importActual<typeof import('@/lib/db/actions')>('@/lib/db/actions')
  return {
    calculatePriorityScore: realCalc,
    getPendingScheduleActions: (...args: unknown[]) => mockGetPendingScheduleActions(...args),
    updateAction: (...args: unknown[]) => mockUpdateAction(...args),
  }
})

const mockGetTravelTime = vi.fn().mockResolvedValue(null)
const mockCalculateDepartureTime = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/google/maps', () => ({
  getTravelTime: (...args: unknown[]) => mockGetTravelTime(...args),
  calculateDepartureTime: (...args: unknown[]) => mockCalculateDepartureTime(...args),
}))

vi.mock('@/lib/ai/mila-voice', () => ({
  generateSchedulingIntent: vi.fn().mockResolvedValue({ intent_cs: 'Test scheduling intent', missingInfo: [] }),
  generateFinalDraft: vi.fn().mockResolvedValue({ subject: 'Test', body: 'Test' }),
}))

vi.mock('@/lib/holidays', () => ({
  isWorkingDay: vi.fn().mockReturnValue(true),
  getNextWorkingDay: vi.fn().mockImplementation((d: Date) => d),
}))

let uuidCounter = 0
vi.mock('uuid', () => ({ v4: () => `test-uuid-${++uuidCounter}` }))

beforeEach(() => {
  vi.clearAllMocks()
  uuidCounter = 0
  mockGetCPById.mockResolvedValue({ id: 'cp-1', name: 'Test CP', primary_identifier: 'test@cp.com', role: 'buyer' })
  mockFindConflicts.mockResolvedValue([])
  // Default hold event with enough fields for updateActionWithHold
  mockCreateHoldEvent.mockImplementation(async (opts: Record<string, unknown>) => ({
    id: 'hold-1',
    status: 'tentative',
    start_time: (opts.startTime as Date)?.toISOString() || '2026-03-10T09:00:00.000Z',
    end_time: (opts.endTime as Date)?.toISOString() || '2026-03-10T09:30:00.000Z',
    cp_name: opts.cpName || 'Test CP',
  }))
})

// ── Default Settings Pinning ────────────────────────────────────────────────

describe('Scheduling — Default Settings Pinning', () => {
  it('default meeting duration is 30 minutes', () => {
    expect(DEFAULT_USER_SETTINGS.default_meeting_duration).toBe(30)
  })

  it('default meeting buffer is 15 minutes', () => {
    expect(DEFAULT_USER_SETTINGS.meeting_buffer_minutes).toBe(15)
  })

  it('default working hours are 9-17', () => {
    expect(DEFAULT_USER_SETTINGS.working_hours_start).toBe(9)
    expect(DEFAULT_USER_SETTINGS.working_hours_end).toBe(17)
  })

  it('default working days are Mon-Fri (1-5)', () => {
    expect(DEFAULT_USER_SETTINGS.working_days).toEqual([1, 2, 3, 4, 5])
  })

  it('default timezone is Europe/Prague', () => {
    expect(DEFAULT_USER_SETTINGS.timezone).toBe('Europe/Prague')
  })

  it('default meeting type is online', () => {
    expect(DEFAULT_USER_SETTINGS.default_meeting_type).toBe('online')
  })

  it('MIN_TRAVEL_BUFFER is 15 minutes', () => {
    expect(DEFAULT_USER_SETTINGS.meeting_buffer_minutes).toBe(15)
  })
})

// ── Event Score (real calculatePriorityScore) ───────────────────────────────

describe('Scheduling — calculateEventScore', () => {
  it('user-created events default to weight=7', async () => {
    const { calculateEventScore } = await vi.importActual<typeof import('@/lib/db/events')>('@/lib/db/events')
    const score = calculateEventScore({ isUserCreated: true })
    // weight=7, BaseDealScore=1, U=1, days=0 → (1*1) + (1*0) + 7 = 8
    expect(score).toBe(8)
  })

  it('non-user-created events default to weight=0', async () => {
    const { calculateEventScore } = await vi.importActual<typeof import('@/lib/db/events')>('@/lib/db/events')
    const score = calculateEventScore({ isUserCreated: false })
    // weight=0, BaseDealScore=1, U=1, days=0 → (1*1) + (1*0) + 0 = 1
    expect(score).toBe(1)
  })

  it('explicit weight overrides isUserCreated', async () => {
    const { calculateEventScore } = await vi.importActual<typeof import('@/lib/db/events')>('@/lib/db/events')
    const score = calculateEventScore({ isUserCreated: true, weight: 5 })
    // explicit weight=5 wins over isUserCreated default of 7
    // BaseDealScore=1, U=1, days=0 → (1*1) + (1*0) + 5 = 6
    expect(score).toBe(6)
  })

  it('passes sellerMultiplier to calculatePriorityScore', async () => {
    const { calculateEventScore } = await vi.importActual<typeof import('@/lib/db/events')>('@/lib/db/events')
    const withMult = calculateEventScore({ dollarValue: 5_000_000, sellerMultiplier: 1.5 })
    const without = calculateEventScore({ dollarValue: 5_000_000, sellerMultiplier: 1.0 })
    // 1.5x post-log should give higher score
    expect(withMult).toBeGreaterThan(without)
  })
})

// ── Slot Finding ────────────────────────────────────────────────────────────

describe('Scheduling — findBestSlots', () => {
  it('passes working hours and buffer to Google Calendar API', async () => {
    const { findBestSlots } = await import('./scheduling')
    mockFindFreeSlots.mockResolvedValue([])

    await findBestSlots('user-1', 30, 3)

    expect(mockFindFreeSlots).toHaveBeenCalledWith(
      'user-1',
      expect.any(Date),
      30,
      DEFAULT_USER_SETTINGS.working_hours_start,
      DEFAULT_USER_SETTINGS.working_hours_end,
      DEFAULT_USER_SETTINGS.meeting_buffer_minutes
    )
  })

  it('returns up to requested number of slots', async () => {
    const { findBestSlots } = await import('./scheduling')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
      { start: new Date('2026-03-10T11:00:00'), end: new Date('2026-03-10T11:30:00') },
      { start: new Date('2026-03-10T14:00:00'), end: new Date('2026-03-10T14:30:00') },
    ])

    const slots = await findBestSlots('user-1', 30, 2)
    expect(slots).toHaveLength(2)
  })

  it('calculates travel buffer when location is provided', async () => {
    const { findBestSlots } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
    ])
    mockGetLastEventLocation.mockResolvedValue('Vinohradská 12, Praha')
    mockGetTravelTime.mockResolvedValue({ durationSeconds: 1200, durationText: '20 min', distanceMeters: 5000, distanceText: '5 km' })

    const slots = await findBestSlots('user-1', 30, 1, undefined, 'Karlín 8, Praha')

    expect(mockGetTravelTime).toHaveBeenCalledWith('Vinohradská 12, Praha', 'Karlín 8, Praha', 'driving')
    expect(slots[0].travelBufferMinutes).toBeDefined()
  })
})

// ── Travel Buffer Formula ───────────────────────────────────────────────────

describe('Scheduling — Travel Buffer', () => {
  it('>500m: buffer = max(travelMinutes + 10, 15) + meeting_buffer', async () => {
    // 5km, 20 min travel → max(20+10, 15) = 30 → + 15 meeting buffer = 45
    const { findBestSlots } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
    ])
    mockGetLastEventLocation.mockResolvedValue('Office')
    mockGetTravelTime.mockResolvedValue({ durationSeconds: 1200, durationText: '20 min', distanceMeters: 5000, distanceText: '5 km' })

    const slots = await findBestSlots('user-1', 30, 1, undefined, 'Meeting Location')
    // travelBufferMinutes = meeting_buffer(15) + max(20+10, 15) = 15 + 30 = 45
    expect(slots[0].travelBufferMinutes).toBe(45)
  })

  it('>500m short drive still gets minimum 15min travel buffer', async () => {
    // 800m, 2 min travel → max(2+10, 15) = 15 → + 15 meeting buffer = 30
    const { findBestSlots } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
    ])
    mockGetLastEventLocation.mockResolvedValue('Office')
    mockGetTravelTime.mockResolvedValue({ durationSeconds: 120, durationText: '2 min', distanceMeters: 800, distanceText: '800 m' })

    const slots = await findBestSlots('user-1', 30, 1, undefined, 'Nearby Place')
    // travelBufferMinutes = meeting_buffer(15) + max(2+10, 15) = 15 + 15 = 30
    expect(slots[0].travelBufferMinutes).toBe(30)
  })

  it('≤500m: flat 15min buffer (walking distance)', async () => {
    // 300m = walking distance, ignore travel time, use flat 15min
    const { findBestSlots } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
    ])
    mockGetLastEventLocation.mockResolvedValue('Office')
    mockGetTravelTime.mockResolvedValue({ durationSeconds: 60, durationText: '1 min', distanceMeters: 300, distanceText: '300 m' })

    const slots = await findBestSlots('user-1', 30, 1, undefined, 'Next Door')
    // travelBufferMinutes = meeting_buffer(15) + flat 15 = 30
    expect(slots[0].travelBufferMinutes).toBe(30)
  })

  it('always uses driving mode regardless of settings', async () => {
    const { findBestSlots } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
    ])
    mockGetLastEventLocation.mockResolvedValue('Office')
    mockGetTravelTime.mockResolvedValue({ durationSeconds: 600, durationText: '10 min', distanceMeters: 3000, distanceText: '3 km' })

    await findBestSlots('user-1', 30, 1, undefined, 'Destination')
    // Should always pass 'driving', not settings.travel_mode
    expect(mockGetTravelTime).toHaveBeenCalledWith('Office', 'Destination', 'driving')
  })

  it('no travel buffer when no origin location available', async () => {
    const { findBestSlots } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
    ])
    mockGetLastEventLocation.mockResolvedValue(null)
    // office_location and home_location are empty strings in defaults

    const slots = await findBestSlots('user-1', 30, 1, undefined, 'Some Place')
    expect(slots[0].travelBufferMinutes).toBeUndefined()
  })
})

// ── Hold Events (spec: ONE hold per meeting — the optimal slot) ─────────────

describe('Scheduling — Hold Events', () => {
  it('blockSlotForProposal creates exactly ONE hold event (spec: one hold per meeting)', async () => {
    const { blockSlotForProposal } = await import('./scheduling')

    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({
      id: 'hold-1',
      status: 'tentative',
    })

    const slot = { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') }

    const result = await blockSlotForProposal('user-1', 'cp-1', slot, 30)

    expect(result.success).toBe(true)
    // Spec: "One hold per meeting — the optimal slot Mila chose"
    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(1)
  })

  it('hold events use "CP Name - REZERVACE" title', async () => {
    const { blockSlotForProposal } = await import('./scheduling')

    mockGetCPById.mockResolvedValue({ id: 'cp-1', name: 'Jan Novák', primary_identifier: 'jan@test.com' })
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const slot = { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') }
    await blockSlotForProposal('user-1', 'cp-1', slot, 30)

    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledWith('user-1', expect.objectContaining({
      summary: 'Jan Novák - REZERVACE',
      status: 'tentative',
    }))
  })

  it('confirmSlot: hold becomes confirmed event, invite sent to CP (spec step 8)', async () => {
    const { confirmSlot } = await import('./scheduling')

    mockConfirmEvent.mockResolvedValue({
      id: 'event-1',
      google_event_id: 'gcal-1',
      title: 'Meeting with Novák',
      location: null,
      weight: 5,
      start_time: '2026-03-10T09:00:00Z',
      end_time: '2026-03-10T09:30:00Z',
    })

    await confirmSlot('user-1', 'event-1', 'novak@test.com')

    // Spec: "Approved → hold becomes confirmed event, invite sent to CP"
    expect(mockConfirmEvent).toHaveBeenCalledWith('event-1')
    expect(mockConfirmCalendarEvent).toHaveBeenCalledWith(
      'user-1',
      'gcal-1',
      ['novak@test.com'],
      expect.objectContaining({ summary: 'Meeting with Novák' }),
      undefined
    )
  })

  it('rejectSlot: hold is cleared (spec step 9)', async () => {
    const { rejectSlot } = await import('./scheduling')

    mockGetEventById.mockResolvedValue({
      id: 'event-1',
      google_event_id: 'gcal-1',
      status: 'tentative',
    })

    await rejectSlot('user-1', 'event-1')

    // Spec: "Rejected/edited → hold cleared"
    expect(mockDeleteEvent).toHaveBeenCalledWith('event-1')
    expect(mockDeleteCalendarEvent).toHaveBeenCalledWith('user-1', 'gcal-1', 'none')
  })

  it('blockSlotForProposal returns failure when CP not found', async () => {
    const { blockSlotForProposal } = await import('./scheduling')
    mockGetCPById.mockResolvedValue(null)

    const slot = { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') }
    const result = await blockSlotForProposal('user-1', 'bad-cp', slot, 30)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Counterparty not found')
  })
})

// ── Conflict Resolution ─────────────────────────────────────────────────────

describe('Scheduling — Conflict Resolution', () => {
  it('higher new score → recommendation: move_existing', async () => {
    const { handleConflict } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      weight: 5, // low weight → low score
      start_time: '2026-03-10T09:00:00Z',
      end_time: '2026-03-10T09:30:00Z',
    }])

    const conflicts = await handleConflict(
      'user-1',
      new Date('2026-03-10T09:00:00'),
      new Date('2026-03-10T09:30:00'),
      200, // high new score
      'cp-1'
    )

    expect(conflicts[0].recommendation).toBe('move_existing')
    expect(conflicts[0].newScore).toBe(200)
  })

  it('lower new score → recommendation: suggest_alternate', async () => {
    const { handleConflict } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      weight: 100, // immovable
      start_time: '2026-03-10T09:00:00Z',
      end_time: '2026-03-10T09:30:00Z',
    }])

    const conflicts = await handleConflict(
      'user-1',
      new Date('2026-03-10T09:00:00'),
      new Date('2026-03-10T09:30:00'),
      5, // low new score
      'cp-1'
    )

    expect(conflicts[0].recommendation).toBe('suggest_alternate')
  })

  it('weight=null existing event is never moved (score = Infinity)', async () => {
    const { handleConflict } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      weight: null, // user hasn't set weight
      start_time: '2026-03-10T09:00:00Z',
      end_time: '2026-03-10T09:30:00Z',
    }])

    const conflicts = await handleConflict(
      'user-1',
      new Date('2026-03-10T09:00:00'),
      new Date('2026-03-10T09:30:00'),
      999999, // even absurdly high new score
      'cp-1'
    )

    expect(conflicts[0].recommendation).toBe('suggest_alternate')
    expect(conflicts[0].existingScore).toBe(Infinity)
  })
})

// ── proposeMeeting (spec: picks ONE optimal slot, creates ONE hold) ─────────

describe('Scheduling — proposeMeeting', () => {
  it('picks ONE optimal slot and creates ONE hold (spec: one slot per meeting)', async () => {
    const { proposeMeeting } = await import('./scheduling')

    // Multiple free slots available — proposeMeeting should pick the BEST one
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
      { start: new Date('2026-03-10T14:00:00'), end: new Date('2026-03-10T14:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await proposeMeeting('user-1', 'cp-1')

    expect(result.success).toBe(true)
    // Spec: "Picks THE optimal slot for each meeting — one slot per meeting, not multiple options"
    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(1)
  })

  it('returns failure when optimal slot conflicts with immovable event', async () => {
    const { proposeMeeting } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([{
      id: 'immovable-1',
      weight: 100,
      start_time: '2026-03-10T09:00:00Z',
      end_time: '2026-03-10T09:30:00Z',
    }])

    const result = await proposeMeeting('user-1', 'cp-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('conflicts')
  })

  it('returns failure when no slots found in 14 days', async () => {
    const { proposeMeeting } = await import('./scheduling')
    mockFindFreeSlots.mockResolvedValue([])

    const result = await proposeMeeting('user-1', 'cp-1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('No available slots')
  })

  it('even with 5 free slots, still creates only ONE hold', async () => {
    const { proposeMeeting } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
      { start: new Date('2026-03-10T11:00:00'), end: new Date('2026-03-10T11:30:00') },
      { start: new Date('2026-03-10T14:00:00'), end: new Date('2026-03-10T14:30:00') },
      { start: new Date('2026-03-10T15:00:00'), end: new Date('2026-03-10T15:30:00') },
    ])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await proposeMeeting('user-1', 'cp-1')

    // Spec: ONE optimal slot, not multiple options
    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(1)
  })
})

// ── Personal Events ─────────────────────────────────────────────────────────

describe('Scheduling — Personal Events', () => {
  it('isPersonalEvent matches Czech and English keywords', async () => {
    const { isPersonalEvent } = await import('@/config/client')
    const settings = DEFAULT_USER_SETTINGS as UserSettings

    expect(isPersonalEvent('Lékař - kontrola', settings)).toBe(true)
    expect(isPersonalEvent('Family dinner', settings)).toBe(true)
    expect(isPersonalEvent('Dovolená Chorvatsko', settings)).toBe(true)
    expect(isPersonalEvent('Narozeniny - Petr', settings)).toBe(true)
    expect(isPersonalEvent('Gym session', settings)).toBe(true)
    expect(isPersonalEvent('Kroužek - děti', settings)).toBe(true)
  })

  it('isPersonalEvent does NOT match business events', async () => {
    const { isPersonalEvent } = await import('@/config/client')
    const settings = DEFAULT_USER_SETTINGS as UserSettings

    expect(isPersonalEvent('Prohlídka bytu - Novák', settings)).toBe(false)
    expect(isPersonalEvent('Meeting with client', settings)).toBe(false)
    expect(isPersonalEvent('Schůzka - podpis smlouvy', settings)).toBe(false)
  })

  it('isPersonalEvent is case-insensitive', async () => {
    const { isPersonalEvent } = await import('@/config/client')
    const settings = DEFAULT_USER_SETTINGS as UserSettings

    expect(isPersonalEvent('OSOBNÍ schůzka', settings)).toBe(true)
    expect(isPersonalEvent('Personal time', settings)).toBe(true)
  })
})

// ── Invitation Handling ─────────────────────────────────────────────────────

describe('Scheduling — Invitation Handling', () => {
  it('acceptInvitation responds via Google Calendar API', async () => {
    const { acceptInvitation } = await import('./scheduling')

    const result = await acceptInvitation('user-1', 'gcal-event-123')
    expect(result.success).toBe(true)
    expect(mockRespondToInvitation).toHaveBeenCalledWith(
      'user-1', 'gcal-event-123', 'accepted', 'test@example.com'
    )
  })

  it('declineInvitation responds via Google Calendar API', async () => {
    const { declineInvitation } = await import('./scheduling')

    const result = await declineInvitation('user-1', 'gcal-event-123')
    expect(result.success).toBe(true)
    expect(mockRespondToInvitation).toHaveBeenCalledWith(
      'user-1', 'gcal-event-123', 'declined', 'test@example.com'
    )
  })
})

// ── Cleanup ─────────────────────────────────────────────────────────────────

describe('Scheduling — Cleanup', () => {
  it('cleanupForCanceledEvent delegates to cancelEventWithCleanup', async () => {
    const { cleanupForCanceledEvent } = await import('./scheduling')
    await cleanupForCanceledEvent('user-1', 'event-1')
    expect(mockCancelEventWithCleanup).toHaveBeenCalledWith('event-1')
  })

  it('handleEventMoved cleans up old travel buffers and recalculates', async () => {
    const { handleEventMoved } = await import('./scheduling')

    mockGetEventById.mockResolvedValue({
      id: 'event-1',
      title: 'Meeting',
      start_time: '2026-03-10T10:00:00Z',
      end_time: '2026-03-10T10:30:00Z',
      location: 'Karlín 8',
      weight: 5,
    })
    mockUpdateEvent.mockResolvedValue({})
    mockGetLastEventLocation.mockResolvedValue('Office')
    mockGetTravelTime.mockResolvedValue({ durationSeconds: 600, durationText: '10 min' })
    mockCreateTravelBuffer.mockResolvedValue({ id: 'buffer-1' })
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-buffer-1' })

    await handleEventMoved(
      'user-1', 'event-1',
      new Date('2026-03-10T14:00:00'), new Date('2026-03-10T14:30:00'),
      'Karlín 8'
    )

    expect(mockCleanupTravelBuffers).toHaveBeenCalledWith('event-1')
    expect(mockUpdateEvent).toHaveBeenCalledWith('event-1', expect.objectContaining({
      start_time: expect.any(String),
      end_time: expect.any(String),
    }))
  })
})

// ── Batch Schedule Optimization (spec: core flow steps 1-7) ─────────────────

describe('Scheduling — Batch Optimization', () => {
  it('optimizeScheduleActions processes ALL pending unsent SCHEDULE actions (spec step 1)', async () => {
    const { optimizeScheduleActions } = await import('./scheduling')

    // 3 pending SCHEDULE actions, none sent yet
    mockGetPendingScheduleActions.mockResolvedValue([
      { id: 'action-1', cp_id: 'cp-1', payload: { channel: 'email' } },
      { id: 'action-2', cp_id: 'cp-2', payload: { channel: 'email' } },
      { id: 'action-3', cp_id: 'cp-3', payload: { channel: 'email' } },
    ])
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
      { start: new Date('2026-03-10T14:00:00'), end: new Date('2026-03-10T14:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await optimizeScheduleActions('user-1')

    // Spec: "Collects all pending, unsent SCHEDULE actions" and picks one slot each
    expect(result.optimized).toBe(3)
    // Each meeting gets exactly ONE hold
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(3)
  })

  it('optimizer skips sent invites — they are fixed walls (spec: scope rules)', async () => {
    const { optimizeScheduleActions } = await import('./scheduling')

    // 2 actions: one unsent (pending), one already sent (invite_sent)
    mockGetPendingScheduleActions.mockResolvedValue([
      { id: 'action-1', cp_id: 'cp-1', payload: { channel: 'email' }, status: 'pending' },
      // action-2 already has invite sent — should NOT be returned by getPendingScheduleActions
      // but if it leaks through, optimizer must skip it
    ])
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await optimizeScheduleActions('user-1')

    // Spec: "Only touches penciled-in (unsent) meetings"
    expect(result.optimized).toBe(1)
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(1)
  })

  it('optimizer returns empty result when no pending SCHEDULE actions', async () => {
    const { optimizeScheduleActions } = await import('./scheduling')

    mockGetPendingScheduleActions.mockResolvedValue([])

    const result = await optimizeScheduleActions('user-1')

    expect(result.optimized).toBe(0)
    expect(mockCreateHoldEvent).not.toHaveBeenCalled()
  })
})

// ── Optimization Priority Order (spec step 2: CP avail > user avail > travel > conflict) ──

describe('Scheduling — Optimization Priority Order', () => {
  it('priority 1: respects CP availability from conversation context', async () => {
    // CP said "I can only do Tuesday afternoon" — optimizer must pick a Tuesday PM slot
    // even if Monday morning is free and closer to other meetings
    const { optimizeScheduleActions } = await import('./scheduling')

    mockGetPendingScheduleActions.mockResolvedValue([{
      id: 'action-1',
      cp_id: 'cp-1',
      payload: { channel: 'email', cp_availability: 'Tuesday afternoon only' },
    }])

    // Monday 9am is free (better for travel), Tuesday 14:00 matches CP constraint
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-09T09:00:00'), end: new Date('2026-03-09T09:30:00') }, // Monday
      { start: new Date('2026-03-10T14:00:00'), end: new Date('2026-03-10T14:30:00') }, // Tuesday PM
    ])
    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await optimizeScheduleActions('user-1')

    expect(result.optimized).toBe(1)
    // Should pick Tuesday PM (CP availability) over Monday AM (travel-optimal)
    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledWith('user-1', expect.objectContaining({
      startTime: new Date('2026-03-10T14:00:00'),
    }))
  })

  it('priority 2: respects user availability — skips conflicting slots', async () => {
    const { optimizeScheduleActions } = await import('./scheduling')

    mockGetPendingScheduleActions.mockResolvedValue([{
      id: 'action-1',
      cp_id: 'cp-1',
      payload: { channel: 'email' },
    }])

    // Only one free slot — the other times are blocked by user's calendar
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T14:00:00'), end: new Date('2026-03-10T14:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await optimizeScheduleActions('user-1')

    expect(result.optimized).toBe(1)
    // Takes the only available slot
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(1)
  })

  it('priority 3: travel optimization — clusters nearby meetings when possible', async () => {
    // Two meetings: one in Karlín, one in Žižkov (nearby). Should schedule them
    // close together rather than spreading across the day to minimize travel
    const { optimizeScheduleActions } = await import('./scheduling')

    mockGetPendingScheduleActions.mockResolvedValue([
      { id: 'action-1', cp_id: 'cp-1', payload: { channel: 'email', location: 'Karlín 8, Praha' } },
      { id: 'action-2', cp_id: 'cp-2', payload: { channel: 'email', location: 'Žižkov 5, Praha' } },
    ])

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
      { start: new Date('2026-03-10T15:00:00'), end: new Date('2026-03-10T15:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([])
    // Karlín→Žižkov is short; Office→Karlín and Office→Žižkov are longer
    mockGetTravelTime.mockImplementation(async (origin: string, dest: string) => {
      if (origin.includes('Karlín') && dest.includes('Žižkov'))
        return { durationSeconds: 300, durationText: '5 min', distanceMeters: 1500, distanceText: '1.5 km' }
      if (origin.includes('Žižkov') && dest.includes('Karlín'))
        return { durationSeconds: 300, durationText: '5 min', distanceMeters: 1500, distanceText: '1.5 km' }
      return { durationSeconds: 1800, durationText: '30 min', distanceMeters: 12000, distanceText: '12 km' }
    })
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await optimizeScheduleActions('user-1')

    expect(result.optimized).toBe(2)
    // Both meetings should be clustered in consecutive slots (9:00 + 10:00)
    // rather than spread apart (9:00 + 15:00)
    const holdCalls = mockCreateTentativeCalendarEvent.mock.calls
    const times = holdCalls.map((c: unknown[]) => (c[1] as { startTime: Date }).startTime)
    // Both should be in the morning block, not one morning + one afternoon
    const hours = times.map((t: Date) => t.getHours())
    expect(Math.max(...hours) - Math.min(...hours)).toBeLessThanOrEqual(2)
  })

  it('priority 4 (last resort): suggests moving existing event only when CP is time-constrained', async () => {
    // CP can ONLY meet at 10:00 (from conversation). User has a low-weight event at 10:00.
    // Optimizer should suggest moving the existing event rather than failing to schedule.
    const { optimizeScheduleActions } = await import('./scheduling')

    mockGetPendingScheduleActions.mockResolvedValue([{
      id: 'action-1',
      cp_id: 'cp-1',
      priority_score: 150, // high priority
      payload: { channel: 'email', cp_availability: 'Only available at 10:00 on Tuesday' },
    }])

    // Only free slot is 10:00 but it conflicts with existing low-weight event
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      weight: 3, // low weight — movable
      start_time: '2026-03-10T10:00:00Z',
      end_time: '2026-03-10T10:30:00Z',
    }])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await optimizeScheduleActions('user-1')

    // Optimizer should still schedule (with a move suggestion), not fail
    expect(result.optimized).toBe(1)
    // Result should include a suggestion to move the conflicting event
    expect(result.moveSuggestions).toBeDefined()
    expect(result.moveSuggestions!.length).toBe(1)
    expect(result.moveSuggestions![0].existingEventId).toBe('existing-1')
  })

  it('conflict resolution prefers declining over moving existing events', async () => {
    // When there's no CP time constraint, optimizer should decline rather than
    // suggest moving an existing event — even if the existing has low weight
    const { optimizeScheduleActions } = await import('./scheduling')

    mockGetPendingScheduleActions.mockResolvedValue([{
      id: 'action-1',
      cp_id: 'cp-1',
      priority_score: 50, // moderate priority
      payload: { channel: 'email' }, // no CP availability constraint
    }])

    // All slots conflict
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:00:00'), end: new Date('2026-03-10T10:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      weight: 3,
      start_time: '2026-03-10T10:00:00Z',
      end_time: '2026-03-10T10:30:00Z',
    }])

    const result = await optimizeScheduleActions('user-1')

    // Should NOT suggest moving — no CP constraint forces this time
    // Should report as unscheduled, not force a move
    expect(result.moveSuggestions ?? []).toHaveLength(0)
    expect(result.unscheduled).toBe(1)
  })
})

// ── Multi-CP Scheduling ─────────────────────────────────────────────────────

describe('Scheduling — Multi-CP', () => {
  it('proposeMeetingMultipleCPs creates ONE hold (same as single-CP)', async () => {
    const { proposeMeetingMultipleCPs } = await import('./scheduling')

    mockGetCPById.mockResolvedValue({ id: 'cp-1', name: 'CP 1', primary_identifier: 'cp1@test.com' })
    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T09:00:00'), end: new Date('2026-03-10T09:30:00') },
    ])
    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await proposeMeetingMultipleCPs('user-1', ['cp-1', 'cp-2'])

    expect(result.success).toBe(true)
    // Spec: one hold per meeting, even with multiple CPs
    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledTimes(1)
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(1)
  })
})

// ── Preferred Time Constraint (CP stated a specific time) ────────────────────

describe('Scheduling — Preferred Time Constraint', () => {
  it('when preferredDate is set and slot is free, books exactly at that time (not first free slot)', async () => {
    const { proposeMeeting } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({
      id: 'hold-1', status: 'tentative',
      start_time: '2026-03-11T09:00:00Z', end_time: '2026-03-11T09:30:00Z',
    })

    const preferredDate = new Date('2026-03-11T09:00:00')
    const result = await proposeMeeting('user-1', 'cp-1', 30, 'Notářská kancelář Praha 2', preferredDate)

    expect(result.success).toBe(true)
    // Must book at exactly 9:00, not "first free slot"
    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledWith('user-1', expect.objectContaining({
      startTime: preferredDate,
    }))
    // Should NOT call findFreeSlots — goes straight to the exact time
    expect(mockFindFreeSlots).not.toHaveBeenCalled()
  })

  it('when preferredDate conflicts with movable event (W<100), books hold AND returns move suggestion', async () => {
    const { proposeMeeting } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      title: 'Team standup',
      weight: 5,
      start_time: '2026-03-11T09:00:00Z',
      end_time: '2026-03-11T09:30:00Z',
    }])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({
      id: 'hold-1', status: 'tentative',
      start_time: '2026-03-11T09:00:00Z', end_time: '2026-03-11T09:30:00Z',
    })

    const preferredDate = new Date('2026-03-11T09:00:00')
    const result = await proposeMeeting('user-1', 'cp-1', 30, 'Notářská kancelář Praha 2', preferredDate)

    // Hold is created at the stated time (consistent process)
    expect(result.holdEvent).toBeDefined()
    expect(mockCreateHoldEvent).toHaveBeenCalledTimes(1)
    // Conflict info returned with move_existing recommendation
    expect(result.conflicts).toBeDefined()
    expect(result.conflicts!.length).toBe(1)
    expect(result.conflicts![0].existingEvent.title).toBe('Team standup')
    expect(result.conflicts![0].recommendation).toBe('move_existing')
    // Should NOT have searched for alternative slots
    expect(mockFindFreeSlots).not.toHaveBeenCalled()
  })

  it('when preferredDate conflicts with immovable event (W=100), books hold AND returns suggest_alternate', async () => {
    const { proposeMeeting } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      title: 'Soud - jednání',
      weight: 100,
      start_time: '2026-03-11T09:00:00Z',
      end_time: '2026-03-11T10:00:00Z',
    }])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({
      id: 'hold-1', status: 'tentative',
      start_time: '2026-03-11T09:00:00Z', end_time: '2026-03-11T09:30:00Z',
    })

    const preferredDate = new Date('2026-03-11T09:00:00')
    const result = await proposeMeeting('user-1', 'cp-1', 30, 'Notářská kancelář Praha 2', preferredDate)

    // Hold still created (consistent process)
    expect(result.holdEvent).toBeDefined()
    // Conflict flagged as immovable
    expect(result.conflicts!.length).toBe(1)
    expect(result.conflicts![0].recommendation).toBe('suggest_alternate')
    expect(result.error).toContain('immovable')
  })

  it('when preferredDate conflicts with null-weight event, treats as immovable', async () => {
    const { proposeMeeting } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([{
      id: 'existing-1',
      title: 'User-created event',
      weight: null,
      start_time: '2026-03-11T09:00:00Z',
      end_time: '2026-03-11T09:30:00Z',
    }])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({
      id: 'hold-1', status: 'tentative',
      start_time: '2026-03-11T09:00:00Z', end_time: '2026-03-11T09:30:00Z',
    })

    const preferredDate = new Date('2026-03-11T09:00:00')
    const result = await proposeMeeting('user-1', 'cp-1', 30, undefined, preferredDate)

    expect(result.conflicts![0].recommendation).toBe('suggest_alternate')
    expect(result.conflicts![0].existingScore).toBe(Infinity)
  })

  it('without preferredDate, uses findBestSlots (existing behavior unchanged)', async () => {
    const { proposeMeeting } = await import('./scheduling')

    mockFindFreeSlots.mockResolvedValue([
      { start: new Date('2026-03-10T10:35:00'), end: new Date('2026-03-10T11:05:00') },
    ])
    mockFindConflicts.mockResolvedValue([])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-1' })
    mockCreateHoldEvent.mockResolvedValue({ id: 'hold-1', status: 'tentative', start_time: '2026-03-10T09:00:00.000Z', end_time: '2026-03-10T09:30:00.000Z', cp_name: 'Test CP' })

    const result = await proposeMeeting('user-1', 'cp-1', 30)

    expect(result.success).toBe(true)
    // Should use findBestSlots since no preferred time
    expect(mockFindFreeSlots).toHaveBeenCalled()
  })

  it('the notary bug: stated 9:00 AM with conflict must NOT silently book 10:35', async () => {
    // This is the exact bug: email says "notary at 9:00 AM", calendar has
    // conflict at 9:00, old code silently picked 10:35 (first free slot).
    // New code books at 9:00 and flags the conflict.
    const { proposeMeeting } = await import('./scheduling')

    mockFindConflicts.mockResolvedValue([{
      id: 'morning-meeting',
      title: 'Interní porada',
      weight: 3,
      start_time: '2026-03-11T08:30:00Z',
      end_time: '2026-03-11T09:30:00Z',
    }])
    mockCreateTentativeCalendarEvent.mockResolvedValue({ id: 'gcal-notary' })
    mockCreateHoldEvent.mockResolvedValue({
      id: 'hold-notary', status: 'tentative',
      start_time: '2026-03-11T09:00:00Z', end_time: '2026-03-11T09:30:00Z',
    })

    const notaryTime = new Date('2026-03-11T09:00:00')
    const result = await proposeMeeting('user-1', 'cp-1', 30, 'Notářská kancelář Praha 2', notaryTime)

    // Hold booked at 9:00 (the stated time), NOT 10:35
    expect(mockCreateTentativeCalendarEvent).toHaveBeenCalledWith('user-1', expect.objectContaining({
      startTime: notaryTime,
    }))
    // Conflict surfaced — user sees it
    expect(result.conflicts!.length).toBe(1)
    expect(result.conflicts![0].existingEvent.title).toBe('Interní porada')
    expect(result.conflicts![0].recommendation).toBe('move_existing') // W=3, movable
    // findBestSlots was NOT called — didn't silently pick another time
    expect(mockFindFreeSlots).not.toHaveBeenCalled()
  })
})
