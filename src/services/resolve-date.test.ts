import { describe, it, expect } from 'vitest'
import { resolveProposedDate, shouldUseBusinessDays } from './planning'
import type { UserSettings } from '@/lib/supabase/types'
import type { EnrichedMessageData } from '@/lib/ai/gemini'

// Friday 2026-04-10 (ISO day 5)
const FRIDAY = new Date(2026, 3, 10, 0, 0, 0)
// Wednesday 2026-04-08 (ISO day 3)
const WEDNESDAY = new Date(2026, 3, 8, 0, 0, 0)
// Monday 2026-04-06 (ISO day 1)
const MONDAY = new Date(2026, 3, 6, 0, 0, 0)

const defaultSettings: UserSettings = {
  working_days: [1, 2, 3, 4, 5],
  timezone: 'Europe/Prague',
} as UserSettings

type ProposedTime = NonNullable<EnrichedMessageData['proposedTimes']>[0]

function makeProposed(overrides: Partial<ProposedTime>): ProposedTime {
  return {
    original: 'test',
    interpreted: 'test',
    ...overrides,
  }
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('resolveProposedDate', () => {
  it('"zítra" on Friday + eventContext "viewing" → Saturday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow', eventContext: 'viewing' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-11') // Saturday
    expect(result!.confidence).toBe('day')
  })

  it('"zítra" on Friday + eventContext "legal" → Monday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow', eventContext: 'legal' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-13') // Monday
    expect(result!.confidence).toBe('inferred')
  })

  it('"zítra" on Friday + eventContext "phone_call" → Monday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow', eventContext: 'phone_call' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-13') // Monday
    expect(result!.confidence).toBe('inferred')
  })

  it('"zítra" on Friday + eventContext "online_meeting" → Monday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow', eventContext: 'online_meeting' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-13') // Monday
    expect(result!.confidence).toBe('inferred')
  })

  it('"zítra" on Friday + cpRole "notary" → Monday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow' }),
      FRIDAY, defaultSettings, 'notary'
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-13') // Monday
    expect(result!.confidence).toBe('inferred')
  })

  it('"zítra" on Friday + journal says "CP does Saturday viewings" → Saturday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow', eventContext: 'viewing' }),
      FRIDAY, defaultSettings, null, 'CP does Saturday viewings regularly'
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-11') // Saturday
    expect(result!.confidence).toBe('day')
  })

  it('"zítra" on Friday + journal "CP never works weekends" + eventContext "viewing" → Monday (journal overrides context)', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow', eventContext: 'viewing' }),
      FRIDAY, defaultSettings, null, 'CP never works weekends'
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-13') // Monday
    expect(result!.confidence).toBe('inferred')
  })

  it('"v pátek" on Wednesday → this Friday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'specific_day', dayOfWeek: 'friday' }),
      WEDNESDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-10') // Friday
    expect(result!.confidence).toBe('day')
  })

  it('"v pátek" on Friday → today (same day allowed)', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'specific_day', dayOfWeek: 'friday' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-10') // today (Friday)
    expect(result!.confidence).toBe('day')
  })

  it('"15. března" → March 15 regardless of business days', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'specific_date', specificDate: '2026-03-15' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-03-15')
    expect(result!.confidence).toBe('day')
  })

  it('"15. března v 10:00" → March 15 at 10:00 with exact confidence', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'specific_date', specificDate: '2026-03-15', timeOfDay: '10:00' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-03-15')
    expect(result!.time).toBe('10:00')
    expect(result!.confidence).toBe('exact')
  })

  it('"today" → today regardless of anything', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'today' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-10')
    expect(result!.confidence).toBe('day')
  })

  it('"today" with time → exact confidence', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'today', timeOfDay: '14:00' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(result!.time).toBe('14:00')
    expect(result!.confidence).toBe('exact')
  })

  it('"next week" → Monday of next week', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'next_week' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-13') // Monday
    expect(result!.confidence).toBe('inferred')
  })

  it('"this_week" on a working day → today', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'this_week' }),
      WEDNESDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-08') // Wednesday (today, a working day)
    expect(result!.confidence).toBe('inferred')
  })

  it('"day_after_tomorrow" on Friday + business days → Monday', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'day_after_tomorrow', eventContext: 'office_meeting' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    // Calendar day_after_tomorrow = Sunday. Business day → skip to Monday
    expect(dateStr(result!.date)).toBe('2026-04-13')
    expect(result!.confidence).toBe('inferred')
  })

  it('"day_after_tomorrow" on Friday + viewing → Sunday (calendar day)', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'day_after_tomorrow', eventContext: 'viewing' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-12') // Sunday
    expect(result!.confidence).toBe('day')
  })

  it('"tomorrow" on Monday → Tuesday (working day, no snapping needed)', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'tomorrow', eventContext: 'legal' }),
      MONDAY, defaultSettings, null
    )
    expect(result).not.toBeNull()
    expect(dateStr(result!.date)).toBe('2026-04-07') // Tuesday
    expect(result!.confidence).toBe('day')
  })

  it('returns null for unknown relativeRef', () => {
    const result = resolveProposedDate(
      makeProposed({ relativeRef: 'some_unknown_value' }),
      FRIDAY, defaultSettings, null
    )
    expect(result).toBeNull()
  })

  it('returns null when no relativeRef', () => {
    const result = resolveProposedDate(
      makeProposed({}),
      FRIDAY, defaultSettings, null
    )
    expect(result).toBeNull()
  })
})

describe('shouldUseBusinessDays', () => {
  it('viewing → calendar days', () => {
    expect(shouldUseBusinessDays('viewing')).toBe(false)
  })

  it('showing → calendar days', () => {
    expect(shouldUseBusinessDays('showing')).toBe(false)
  })

  it('legal → business days', () => {
    expect(shouldUseBusinessDays('legal')).toBe(true)
  })

  it('notary → business days', () => {
    expect(shouldUseBusinessDays('notary')).toBe(true)
  })

  it('cpRole lawyer overrides viewing context', () => {
    expect(shouldUseBusinessDays('viewing', 'lawyer')).toBe(true)
  })

  it('journal "CP does Saturday viewings" → calendar days', () => {
    expect(shouldUseBusinessDays('legal', null, 'CP does Saturday viewings')).toBe(false)
  })

  it('journal "CP never works weekends" → business days even for viewing', () => {
    expect(shouldUseBusinessDays('viewing', null, 'CP never works weekends')).toBe(true)
  })

  it('journal "nikdy víkend" → business days', () => {
    expect(shouldUseBusinessDays('viewing', null, 'Protistrana nikdy víkend nepracuje')).toBe(true)
  })

  it('journal "jen pracovní dny" → business days', () => {
    expect(shouldUseBusinessDays('viewing', null, 'CP jen pracovní dny')).toBe(true)
  })

  it('phone_call → business days', () => {
    expect(shouldUseBusinessDays('phone_call')).toBe(true)
  })

  it('online_meeting → business days', () => {
    expect(shouldUseBusinessDays('online_meeting')).toBe(true)
  })

  it('no context, no role → default business days', () => {
    expect(shouldUseBusinessDays()).toBe(true)
  })
})
