/**
 * Czech Republic (CZ) public holidays
 * Used to exclude holidays from available scheduling days
 */

/**
 * Fixed CZ public holidays (month is 0-indexed: January = 0)
 */
const FIXED_HOLIDAYS: { month: number; day: number; name: string }[] = [
  { month: 0, day: 1, name: 'Den obnovy samostatného českého státu / Nový rok' },
  { month: 4, day: 1, name: 'Svátek práce' },
  { month: 4, day: 8, name: 'Den vítězství' },
  { month: 6, day: 5, name: 'Den slovanských věrozvěstů Cyrila a Metoděje' },
  { month: 6, day: 6, name: 'Den upálení mistra Jana Husa' },
  { month: 8, day: 28, name: 'Den české státnosti' },
  { month: 9, day: 28, name: 'Den vzniku samostatného československého státu' },
  { month: 10, day: 17, name: 'Den boje za svobodu a demokracii' },
  { month: 11, day: 24, name: 'Štědrý den' },
  { month: 11, day: 25, name: '1. svátek vánoční' },
  { month: 11, day: 26, name: '2. svátek vánoční' },
]

/**
 * Calculate Easter Sunday for a given year using the Anonymous Gregorian algorithm
 */
function getEasterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1

  return new Date(year, month - 1, day)
}

/**
 * Get all CZ public holidays for a given year
 */
export function getCZHolidays(year: number): Date[] {
  const holidays: Date[] = []

  // Fixed holidays
  for (const h of FIXED_HOLIDAYS) {
    holidays.push(new Date(year, h.month, h.day))
  }

  // Easter-based holidays
  const easterSunday = getEasterSunday(year)

  // Good Friday (Velký pátek) - 2 days before Easter Sunday
  const goodFriday = new Date(easterSunday)
  goodFriday.setDate(goodFriday.getDate() - 2)
  holidays.push(goodFriday)

  // Easter Monday (Velikonoční pondělí) - 1 day after Easter Sunday
  const easterMonday = new Date(easterSunday)
  easterMonday.setDate(easterMonday.getDate() + 1)
  holidays.push(easterMonday)

  return holidays
}

/**
 * Check if a given date is a CZ public holiday
 */
export function isCZHoliday(date: Date): boolean {
  const year = date.getFullYear()
  const holidays = getCZHolidays(year)

  return holidays.some(h =>
    h.getFullYear() === date.getFullYear() &&
    h.getMonth() === date.getMonth() &&
    h.getDate() === date.getDate()
  )
}

/**
 * Check if a given date is a working day (not weekend, not CZ holiday)
 * @param date The date to check
 * @param workingDays Array of working day numbers (1=Monday, 7=Sunday), defaults to Mon-Fri
 */
export function isWorkingDay(
  date: Date,
  workingDays: number[] = [1, 2, 3, 4, 5]
): boolean {
  // JavaScript getDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
  // Convert to ISO: 1=Monday, ..., 7=Sunday
  const jsDay = date.getDay()
  const isoDay = jsDay === 0 ? 7 : jsDay

  if (!workingDays.includes(isoDay)) {
    return false
  }

  if (isCZHoliday(date)) {
    return false
  }

  return true
}

/**
 * Get the next working day from a given date
 */
export function getNextWorkingDay(
  date: Date,
  workingDays: number[] = [1, 2, 3, 4, 5]
): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + 1)

  const MAX_ITERATIONS = 366
  let iterations = 0

  while (!isWorkingDay(next, workingDays) && iterations < MAX_ITERATIONS) {
    next.setDate(next.getDate() + 1)
    iterations++
  }

  if (iterations >= MAX_ITERATIONS) {
    console.error('[getNextWorkingDay] Safety limit reached — no working day found within 366 days. Check working_days config.')
  }

  return next
}
