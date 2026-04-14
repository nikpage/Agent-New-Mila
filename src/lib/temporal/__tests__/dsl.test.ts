import { describe, it, expect } from 'vitest'
import {
  tomorrow,
  dateOffset,
  nextWeekday,
  thisWeekday,
  nextWeek,
  atTime,
  startOfDay,
  endOfDay,
  morning,
  afternoon,
  specificDate,
  deadlineBefore,
} from '../dsl'

// Fixed anchor: Wednesday 2026-04-15 10:00:00 UTC
const ANCHOR = new Date('2026-04-15T10:00:00.000Z')

describe('tomorrow', () => {
  it('returns the next calendar day', () => {
    const result = tomorrow(ANCHOR)
    expect(result.getUTCDate()).toBe(16)
    expect(result.getUTCMonth()).toBe(3) // April
  })

  it('does not mutate anchor', () => {
    const before = ANCHOR.getTime()
    tomorrow(ANCHOR)
    expect(ANCHOR.getTime()).toBe(before)
  })
})

describe('dateOffset', () => {
  it('offsets by days', () => {
    const result = dateOffset(ANCHOR, { days: 3 })
    expect(result.getUTCDate()).toBe(18)
  })

  it('offsets by weeks', () => {
    const result = dateOffset(ANCHOR, { weeks: 2 })
    expect(result.getUTCDate()).toBe(29)
  })

  it('combines days and weeks', () => {
    const result = dateOffset(ANCHOR, { days: 1, weeks: 1 })
    expect(result.getUTCDate()).toBe(23) // 15 + 7 + 1
  })

  it('handles zero offset', () => {
    const result = dateOffset(ANCHOR, {})
    expect(result.getTime()).toBe(ANCHOR.getTime())
  })
})

describe('nextWeekday', () => {
  // ANCHOR is Wednesday (day 3)

  it('returns next Friday when anchor is Wednesday', () => {
    const result = nextWeekday(ANCHOR, 5) // Friday
    expect(result.getDay()).toBe(5)
    expect(result.getUTCDate()).toBe(17) // Apr 17
  })

  it('returns next Monday when anchor is Wednesday', () => {
    const result = nextWeekday(ANCHOR, 1) // Monday
    expect(result.getDay()).toBe(1)
    expect(result.getUTCDate()).toBe(20) // Apr 20
  })

  it('always goes forward — same weekday returns +7 days', () => {
    // Wednesday → next Wednesday
    const result = nextWeekday(ANCHOR, 3)
    expect(result.getDay()).toBe(3)
    expect(result.getUTCDate()).toBe(22) // Apr 22
  })

  it('does not mutate anchor', () => {
    const before = ANCHOR.getTime()
    nextWeekday(ANCHOR, 5)
    expect(ANCHOR.getTime()).toBe(before)
  })
})

describe('thisWeekday', () => {
  // ANCHOR is Wednesday (day 3)

  it('returns earlier this week for Monday', () => {
    const result = thisWeekday(ANCHOR, 1) // Monday
    expect(result.getDay()).toBe(1)
    expect(result.getUTCDate()).toBe(13) // Apr 13 (this Mon)
  })

  it('returns same day when anchor matches', () => {
    const result = thisWeekday(ANCHOR, 3) // Wednesday
    expect(result.getDay()).toBe(3)
    expect(result.getUTCDate()).toBe(15)
  })

  it('returns later this week for Friday', () => {
    const result = thisWeekday(ANCHOR, 5) // Friday
    expect(result.getDay()).toBe(5)
    expect(result.getUTCDate()).toBe(17)
  })
})

describe('nextWeek', () => {
  it('returns Monday of next week', () => {
    const result = nextWeek(ANCHOR)
    expect(result.getDay()).toBe(1) // Monday
    expect(result.getUTCDate()).toBe(20) // Apr 20
  })
})

describe('atTime', () => {
  it('sets hour and minute', () => {
    const result = atTime(ANCHOR, 14, 30)
    expect(result.getHours()).toBe(14)
    expect(result.getMinutes()).toBe(30)
    expect(result.getSeconds()).toBe(0)
  })

  it('does not mutate source date', () => {
    const d = new Date('2026-04-15T10:00:00')
    const before = d.getTime()
    atTime(d, 9, 0)
    expect(d.getTime()).toBe(before)
  })
})

describe('startOfDay / endOfDay / morning / afternoon', () => {
  it('startOfDay returns 09:00', () => {
    const result = startOfDay(ANCHOR)
    expect(result.getHours()).toBe(9)
    expect(result.getMinutes()).toBe(0)
  })

  it('endOfDay returns 17:00', () => {
    const result = endOfDay(ANCHOR)
    expect(result.getHours()).toBe(17)
    expect(result.getMinutes()).toBe(0)
  })

  it('morning returns 09:00', () => {
    expect(morning(ANCHOR).getHours()).toBe(9)
  })

  it('afternoon returns 14:00', () => {
    expect(afternoon(ANCHOR).getHours()).toBe(14)
  })
})

describe('specificDate', () => {
  it('creates a date with correct year/month/day (1-based month)', () => {
    const result = specificDate(2026, 3, 15)
    expect(result.getFullYear()).toBe(2026)
    expect(result.getMonth()).toBe(2) // March = index 2
    expect(result.getDate()).toBe(15)
  })

  it('defaults to 09:00', () => {
    const result = specificDate(2026, 3, 15)
    expect(result.getHours()).toBe(9)
    expect(result.getMinutes()).toBe(0)
  })
})

describe('deadlineBefore', () => {
  it('returns the same date unchanged', () => {
    const d = new Date('2026-04-17T17:00:00')
    expect(deadlineBefore(d)).toBe(d)
  })
})

describe('function composition', () => {
  it('atTime(tomorrow(anchor), 14, 0) — tomorrow afternoon', () => {
    const result = atTime(tomorrow(ANCHOR), 14, 0)
    expect(result.getUTCDate()).toBe(16)
    expect(result.getHours()).toBe(14)
  })

  it('deadlineBefore(endOfDay(nextWeekday(anchor, 5))) — by this Friday EOD', () => {
    const result = deadlineBefore(endOfDay(nextWeekday(ANCHOR, 5)))
    expect(result.getDay()).toBe(5)
    expect(result.getHours()).toBe(17)
  })

  it('morning(nextWeekday(nextWeek(anchor), 3)) — next week Wednesday morning', () => {
    const result = morning(nextWeekday(nextWeek(ANCHOR), 3))
    expect(result.getDay()).toBe(3)
    expect(result.getHours()).toBe(9)
    // nextWeek → Apr 20 (Mon), nextWeekday(Mon, Wed) → Apr 22
    expect(result.getUTCDate()).toBe(22)
  })
})
