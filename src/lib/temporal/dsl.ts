/**
 * Temporal DSL — functions available to LLM-generated code.
 *
 * All functions accept Date objects and return Date objects.
 * The executor converts the final result to ISO-8601.
 *
 * Day constants: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday,
 *                4=Thursday, 5=Friday, 6=Saturday
 */

/**
 * Next calendar day after anchor.
 * "zítra" → tomorrow(anchor)
 */
export function tomorrow(anchor: Date): Date {
  return dateOffset(anchor, { days: 1 })
}

/**
 * Offset by days and/or weeks.
 * "za 3 dny" → dateOffset(anchor, { days: 3 })
 * "za 2 týdny" → dateOffset(anchor, { weeks: 2 })
 */
export function dateOffset(anchor: Date, offset: { days?: number; weeks?: number }): Date {
  const d = new Date(anchor)
  d.setDate(d.getDate() + (offset.days ?? 0) + (offset.weeks ?? 0) * 7)
  return d
}

/**
 * Next future occurrence of a weekday. Always at least 1 day ahead.
 * If today is that weekday, returns next week's occurrence.
 * "příští pátek" → nextWeekday(anchor, 5)
 */
export function nextWeekday(anchor: Date, day: number): Date {
  const d = new Date(anchor)
  const current = d.getDay()
  let diff = day - current
  if (diff <= 0) diff += 7
  d.setDate(d.getDate() + diff)
  return d
}

/**
 * This week's occurrence of a weekday (may be today or already past).
 * "tento pátek" → thisWeekday(anchor, 5)
 */
export function thisWeekday(anchor: Date, day: number): Date {
  const d = new Date(anchor)
  const current = d.getDay()
  d.setDate(d.getDate() + (day - current))
  return d
}

/**
 * Monday of next week.
 * "příští týden" → nextWeek(anchor)
 */
export function nextWeek(anchor: Date): Date {
  return nextWeekday(anchor, 1)
}

/**
 * Set specific time on a date (hour 0–23, minute 0–59).
 * "v 9:30" → atTime(someDate, 9, 30)
 */
export function atTime(date: Date, hour: number, minute: number): Date {
  const d = new Date(date)
  d.setHours(hour, minute, 0, 0)
  return d
}

/**
 * Set to business start of day (09:00).
 * Use when no specific time is given and morning is implied.
 */
export function startOfDay(date: Date): Date {
  return atTime(date, 9, 0)
}

/**
 * Set to business end of day (17:00).
 * "do konce dne" → endOfDay(someDate)
 */
export function endOfDay(date: Date): Date {
  return atTime(date, 17, 0)
}

/**
 * Set to morning slot (09:00).
 * "ráno" → morning(someDate)
 */
export function morning(date: Date): Date {
  return atTime(date, 9, 0)
}

/**
 * Set to afternoon slot (14:00).
 * "odpoledne" → afternoon(someDate)
 */
export function afternoon(date: Date): Date {
  return atTime(date, 14, 0)
}

/**
 * Absolute date. Month is 1-based (January = 1).
 * "15. března" → specificDate(anchor.getFullYear(), 3, 15)
 * "15. března 2026" → specificDate(2026, 3, 15)
 */
export function specificDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 9, 0, 0, 0)
}

/**
 * Marks a date as a deadline. Returns the date unchanged.
 * Semantic annotation only — use it to clarify intent.
 * "do pátku" → deadlineBefore(nextWeekday(anchor, 5))
 */
export function deadlineBefore(date: Date): Date {
  return date
}
