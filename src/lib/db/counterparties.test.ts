import { describe, it, expect } from 'vitest'
import { isSameGmailAddress, normalizeGmailAddress } from './counterparties'

describe('isSameGmailAddress', () => {
  it('matches identical emails', () => {
    expect(isSameGmailAddress('jan@gmail.com', 'jan@gmail.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSameGmailAddress('Jan@Gmail.Com', 'jan@gmail.com')).toBe(true)
  })

  it('treats dots as irrelevant in Gmail local part', () => {
    expect(isSameGmailAddress('first.last@gmail.com', 'firstlast@gmail.com')).toBe(true)
    expect(isSameGmailAddress('f.i.r.s.t.last@gmail.com', 'firstlast@gmail.com')).toBe(true)
  })

  it('preserves dots in non-Gmail local part', () => {
    expect(isSameGmailAddress('first.last@company.com', 'firstlast@company.com')).toBe(false)
  })

  it('treats domain dots as significant (DNS)', () => {
    expect(isSameGmailAddress('jan@pod.one', 'jan@podone')).toBe(false)
  })

  it('different emails are not the same', () => {
    expect(isSameGmailAddress('alice@gmail.com', 'bob@gmail.com')).toBe(false)
    expect(isSameGmailAddress('jan@gmail.com', 'jan@yahoo.com')).toBe(false)
  })

  it('handles whitespace trimming', () => {
    expect(isSameGmailAddress('  jan@gmail.com  ', 'jan@gmail.com')).toBe(true)
  })
})

describe('normalizeGmailAddress', () => {
  it('lowercases and trims', () => {
    expect(normalizeGmailAddress('  Jan@Gmail.Com  ')).toBe('jan@gmail.com')
  })

  it('strips dots from Gmail local part only', () => {
    expect(normalizeGmailAddress('first.last@gmail.com')).toBe('firstlast@gmail.com')
    expect(normalizeGmailAddress('first.last@googlemail.com')).toBe('firstlast@googlemail.com')
  })

  it('preserves dots in non-Gmail addresses', () => {
    expect(normalizeGmailAddress('first.last@company.com')).toBe('first.last@company.com')
    expect(normalizeGmailAddress('first.last@pod.one')).toBe('first.last@pod.one')
  })

  it('normalizes Gmail dot variants to same string', () => {
    const a = normalizeGmailAddress('f.i.r.s.t.last@gmail.com')
    const b = normalizeGmailAddress('firstlast@gmail.com')
    expect(a).toBe(b)
  })

  it('handles missing @ gracefully', () => {
    expect(normalizeGmailAddress('nope')).toBe('nope')
  })

  it('is idempotent', () => {
    const once = normalizeGmailAddress('First.Last@Gmail.Com')
    const twice = normalizeGmailAddress(once)
    expect(once).toBe('firstlast@gmail.com')
    expect(once).toBe(twice)
  })

  it('is idempotent for non-Gmail', () => {
    const once = normalizeGmailAddress('First.Last@Company.Com')
    const twice = normalizeGmailAddress(once)
    expect(once).toBe('first.last@company.com')
    expect(once).toBe(twice)
  })
})
