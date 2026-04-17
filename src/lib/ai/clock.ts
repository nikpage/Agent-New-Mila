/**
 * Injectable clock for AI prompt builders.
 *
 * Production: returns real wall-clock time.
 * Test/replay: returns a fixed instant when AI_CASSETTE_FIXED_NOW is set,
 * so cassette keys stay stable across runs and relative-date extraction
 * is still exercised against a known "today".
 */
export function promptNow(): Date {
  const fixed = process.env.AI_CASSETTE_FIXED_NOW
  if (fixed) {
    const d = new Date(fixed)
    if (!isNaN(d.getTime())) return d
  }
  return new Date()
}
