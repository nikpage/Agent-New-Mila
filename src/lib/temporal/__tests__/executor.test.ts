import { describe, it, expect } from 'vitest'
import { executeDSLCode } from '../executor'

const ANCHOR = new Date('2026-04-15T10:00:00.000Z')

describe('executeDSLCode — basic execution', () => {
  it('evaluates tomorrow(anchor)', () => {
    const result = executeDSLCode('tomorrow(anchor)', ANCHOR)
    const d = new Date(result)
    expect(d.getUTCDate()).toBe(16)
  })

  it('evaluates composed expression', () => {
    const result = executeDSLCode('atTime(tomorrow(anchor), 14, 0)', ANCHOR)
    const d = new Date(result)
    expect(d.getUTCDate()).toBe(16)
    expect(d.getHours()).toBe(14)
  })

  it('returns ISO-8601 string', () => {
    const result = executeDSLCode('tomorrow(anchor)', ANCHOR)
    expect(typeof result).toBe('string')
    expect(() => new Date(result)).not.toThrow()
    expect(new Date(result).toISOString()).toBe(result)
  })

  it('does not mutate anchor', () => {
    const before = ANCHOR.getTime()
    executeDSLCode('tomorrow(anchor)', ANCHOR)
    expect(ANCHOR.getTime()).toBe(before)
  })
})

describe('executeDSLCode — sandbox safety', () => {
  it('throws on access to process', () => {
    expect(() => executeDSLCode('process.exit(0)', ANCHOR)).toThrow()
  })

  it('throws on access to require', () => {
    expect(() => executeDSLCode('require("fs")', ANCHOR)).toThrow()
  })

  it('throws on access to globalThis', () => {
    expect(() => executeDSLCode('globalThis.process', ANCHOR)).toThrow()
  })

  it('throws on access to __dirname', () => {
    expect(() => executeDSLCode('__dirname', ANCHOR)).toThrow()
  })

  it('throws on undefined function', () => {
    expect(() => executeDSLCode('notAFunction(anchor)', ANCHOR)).toThrow()
  })

  it('enforces 1-second timeout on infinite loop', () => {
    expect(() =>
      executeDSLCode('(function(){ while(true){} })()', ANCHOR)
    ).toThrow()
  }, 2500)
})

describe('executeDSLCode — error handling', () => {
  it('throws on non-date return value', () => {
    expect(() => executeDSLCode('"not a date"', ANCHOR)).toThrow()
  })

  it('throws on numeric return value', () => {
    expect(() => executeDSLCode('42', ANCHOR)).toThrow()
  })

  it('throws on null return value', () => {
    expect(() => executeDSLCode('null', ANCHOR)).toThrow()
  })
})
