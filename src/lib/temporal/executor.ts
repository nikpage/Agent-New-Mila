/**
 * Temporal DSL executor.
 * Runs LLM-generated code in a vm.runInNewContext() sandbox with only DSL
 * functions and the anchor date available. No filesystem, no network, 1s timeout.
 *
 * Node.js server-side only — never runs in edge runtime or browser.
 */

import vm from 'vm'
import * as dsl from './dsl'

const TIMEOUT_MS = 1000

/**
 * Executes a single DSL expression string and returns an ISO-8601 date string.
 * Throws if the code times out, accesses forbidden globals, or returns a
 * non-date value.
 *
 * @param code  e.g. `atTime(tomorrow(anchor), 9, 0)`
 * @param anchor  the message timestamp used as the reference point
 */
export function executeDSLCode(code: string, anchor: Date): string {
  // Sandbox: only DSL functions + anchor. No globals.
  const context = vm.createContext({
    anchor: new Date(anchor), // defensive copy
    tomorrow: dsl.tomorrow,
    dateOffset: dsl.dateOffset,
    nextWeekday: dsl.nextWeekday,
    thisWeekday: dsl.thisWeekday,
    nextWeek: dsl.nextWeek,
    atTime: dsl.atTime,
    startOfDay: dsl.startOfDay,
    endOfDay: dsl.endOfDay,
    morning: dsl.morning,
    afternoon: dsl.afternoon,
    specificDate: dsl.specificDate,
    deadlineBefore: dsl.deadlineBefore,
  })

  let result: unknown
  try {
    result = vm.runInContext(code, context, { timeout: TIMEOUT_MS })
  } catch (err) {
    // Re-throw with cleaner message
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`DSL execution failed: ${msg}`)
  }

  if (result instanceof Date) {
    if (isNaN(result.getTime())) throw new Error('DSL code returned invalid Date (NaN)')
    return result.toISOString()
  }

  if (typeof result === 'string') {
    const parsed = new Date(result)
    if (isNaN(parsed.getTime())) throw new Error(`DSL code returned non-date string: ${result}`)
    return result
  }

  throw new Error(`DSL code returned unexpected type: ${typeof result} — expected Date`)
}
