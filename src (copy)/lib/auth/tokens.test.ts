import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  generateActionToken,
  validateActionToken,
  generateOAuthState,
  validateOAuthState,
  generateTriggerToken,
  validateTriggerToken,
  validateCronToken,
} from './tokens'

const TEST_SECRET = 'test-secret-key-for-hmac-signing-32chars'

describe('Action Tokens', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', TEST_SECRET)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('generates a token that validates correctly', () => {
    const actionId = 'action-123'
    const userId = 'user-456'
    const token = generateActionToken(actionId, userId)
    expect(validateActionToken(token, actionId, userId)).toBe(true)
  })

  it('rejects token with wrong actionId', () => {
    const token = generateActionToken('action-123', 'user-456')
    expect(validateActionToken(token, 'wrong-action', 'user-456')).toBe(false)
  })

  it('rejects token with wrong userId', () => {
    const token = generateActionToken('action-123', 'user-456')
    expect(validateActionToken(token, 'action-123', 'wrong-user')).toBe(false)
  })

  it('rejects expired token', () => {
    // Forge a token with a timestamp 2 hours in the past
    const oldTimestamp = (Date.now() - 2 * 60 * 60 * 1000).toString()
    const payload = `action-123.user-456.${oldTimestamp}`
    const { createHmac } = require('crypto')
    const sig = createHmac('sha256', TEST_SECRET).update(payload).digest('hex').slice(0, 32)
    const token = `${oldTimestamp}.${sig}`
    // maxAge = 1 hour → token is 2h old → should be expired
    expect(validateActionToken(token, 'action-123', 'user-456', 60 * 60 * 1000)).toBe(false)
  })

  it('rejects malformed token (missing parts)', () => {
    expect(validateActionToken('just-one-part', 'a', 'b')).toBe(false)
    expect(validateActionToken('a.b.c', 'a', 'b')).toBe(false)
    expect(validateActionToken('', 'a', 'b')).toBe(false)
  })

  it('rejects token with non-numeric timestamp', () => {
    expect(validateActionToken('notanumber.abcdef1234567890abcdef1234567890', 'a', 'b')).toBe(false)
  })

  it('throws when NEXTAUTH_SECRET is missing', () => {
    vi.stubEnv('NEXTAUTH_SECRET', '')
    delete process.env.NEXTAUTH_SECRET
    expect(() => generateActionToken('a', 'b')).toThrow('NEXTAUTH_SECRET not configured')
  })
})

describe('OAuth State', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', TEST_SECRET)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('round-trips userId through state token', () => {
    const userId = 'ee23bcb7-ee2c-4e3f-a686-fb955ba0d753'
    const state = generateOAuthState(userId)
    const extracted = validateOAuthState(state)
    expect(extracted).toBe(userId)
  })

  it('rejects expired state', () => {
    // Use vi.useFakeTimers to generate a state in the past, then advance time
    vi.useFakeTimers()
    const state = generateOAuthState('user-123')
    // Advance time by 15 minutes
    vi.advanceTimersByTime(15 * 60 * 1000)
    // Default maxAge is 10 minutes — this state should be expired
    const extracted = validateOAuthState(state, 10 * 60 * 1000)
    vi.useRealTimers()
    expect(extracted).toBeNull()
  })

  it('rejects tampered state', () => {
    const state = generateOAuthState('user-123')
    const tampered = state.slice(0, -2) + 'XX'
    expect(validateOAuthState(tampered)).toBeNull()
  })

  it('rejects garbage input', () => {
    expect(validateOAuthState('not-base64url')).toBeNull()
    expect(validateOAuthState('')).toBeNull()
  })
})

describe('Trigger Tokens', () => {
  beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', TEST_SECRET)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('generates a token that validates', () => {
    const userId = 'user-789'
    const token = generateTriggerToken(userId)
    expect(validateTriggerToken(token, userId)).toBe(true)
  })

  it('rejects token for different userId', () => {
    const token = generateTriggerToken('user-789')
    expect(validateTriggerToken(token, 'user-other')).toBe(false)
  })

  it('is deterministic (same userId → same token)', () => {
    const t1 = generateTriggerToken('user-789')
    const t2 = generateTriggerToken('user-789')
    expect(t1).toBe(t2)
  })

  it('produces different tokens for different users', () => {
    const t1 = generateTriggerToken('user-A')
    const t2 = generateTriggerToken('user-B')
    expect(t1).not.toBe(t2)
  })
})

describe('Cron Token Validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts valid cron token', () => {
    vi.stubEnv('CRON_SECRET', 'my-cron-secret')
    expect(validateCronToken('my-cron-secret')).toBe(true)
  })

  it('rejects wrong cron token', () => {
    vi.stubEnv('CRON_SECRET', 'my-cron-secret')
    expect(validateCronToken('wrong-token')).toBe(false)
  })

  it('rejects null/undefined token', () => {
    vi.stubEnv('CRON_SECRET', 'my-cron-secret')
    expect(validateCronToken(null)).toBe(false)
    expect(validateCronToken(undefined)).toBe(false)
  })

  it('rejects when CRON_SECRET is not configured', () => {
    delete process.env.CRON_SECRET
    expect(validateCronToken('anything')).toBe(false)
  })

  it('rejects token of different length (timing-safe check)', () => {
    vi.stubEnv('CRON_SECRET', 'exact-16-chars!!')
    expect(validateCronToken('short')).toBe(false)
  })
})
