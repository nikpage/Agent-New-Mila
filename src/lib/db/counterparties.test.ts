import { describe, it, expect } from 'vitest'
import { isSameGmailAddress } from './counterparties'

describe('isSameGmailAddress', () => {
  it('matches identical emails', () => {
    expect(isSameGmailAddress('jan@gmail.com', 'jan@gmail.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSameGmailAddress('Jan@Gmail.Com', 'jan@gmail.com')).toBe(true)
  })

  it('treats dots as irrelevant in local part', () => {
    expect(isSameGmailAddress('first.last@gmail.com', 'firstlast@gmail.com')).toBe(true)
    expect(isSameGmailAddress('f.i.r.s.t.last@gmail.com', 'firstlast@gmail.com')).toBe(true)
  })

  it('treats dots as irrelevant in domain part', () => {
    expect(isSameGmailAddress('jan@pod.one', 'jan@podone')).toBe(true)
  })

  it('different emails are not the same', () => {
    expect(isSameGmailAddress('alice@gmail.com', 'bob@gmail.com')).toBe(false)
    expect(isSameGmailAddress('jan@gmail.com', 'jan@yahoo.com')).toBe(false)
  })

  it('handles whitespace trimming', () => {
    expect(isSameGmailAddress('  jan@gmail.com  ', 'jan@gmail.com')).toBe(true)
  })
})
