import { describe, it, expect } from 'vitest'
import { isBlockedSender } from './ingestion'

describe('isBlockedSender', () => {
  it('blocks exact sender matches', () => {
    expect(isBlockedSender('no-reply@accounts.google.com')).toBe(true)
    expect(isBlockedSender('noreply@github.com')).toBe(true)
    expect(isBlockedSender('receipts@stripe.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isBlockedSender('No-Reply@Accounts.Google.Com')).toBe(true)
    expect(isBlockedSender('NOREPLY@GITHUB.COM')).toBe(true)
  })

  it('blocks prefix-based matches', () => {
    expect(isBlockedSender('noreply@anydomain.com')).toBe(true)
    expect(isBlockedSender('no-reply@anydomain.com')).toBe(true)
    expect(isBlockedSender('mailer-daemon@somehost.net')).toBe(true)
    expect(isBlockedSender('postmaster@company.com')).toBe(true)
  })

  it('blocks prefix+subaddress patterns (noreply+tag@)', () => {
    expect(isBlockedSender('noreply+something@example.com')).toBe(true)
    expect(isBlockedSender('no-reply+test@example.com')).toBe(true)
  })

  it('blocks domain-based matches', () => {
    expect(isBlockedSender('anything@amazonses.com')).toBe(true)
    expect(isBlockedSender('hello@sendgrid.net')).toBe(true)
    expect(isBlockedSender('invoice@email.shopify.com')).toBe(true)
  })

  it('allows legitimate personal emails', () => {
    expect(isBlockedSender('jan@remax-premium.cz')).toBe(false)
    expect(isBlockedSender('petr.novak@gmail.com')).toBe(false)
    expect(isBlockedSender('info@realcompany.cz')).toBe(false)
  })

  it('allows emails that contain blocked prefixes but are not exact local part', () => {
    // 'notifications' is a blocked prefix, but 'mynotifications' is not
    expect(isBlockedSender('mynotifications@example.com')).toBe(false)
  })

  it('handles emails without @ sign', () => {
    expect(isBlockedSender('not-an-email')).toBe(false)
  })
})
