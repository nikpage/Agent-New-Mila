import { describe, it, expect } from 'vitest'
import { normalizePhoneNumber, phoneToThreadId } from './types'

describe('normalizePhoneNumber', () => {
  it('strips spaces and special chars', () => {
    expect(normalizePhoneNumber('+420 777 123 456')).toBe('+420777123456')
    expect(normalizePhoneNumber('+420-777-123-456')).toBe('+420777123456')
    expect(normalizePhoneNumber('+420.777.123.456')).toBe('+420777123456')
    expect(normalizePhoneNumber('(+420) 777 123 456')).toBe('+420777123456')
  })

  it('adds + prefix if missing', () => {
    expect(normalizePhoneNumber('420777123456')).toBe('+420777123456')
  })

  it('preserves existing + prefix', () => {
    expect(normalizePhoneNumber('+420777123456')).toBe('+420777123456')
  })

  it('handles already-clean numbers', () => {
    expect(normalizePhoneNumber('+1234567890')).toBe('+1234567890')
  })
})

describe('phoneToThreadId', () => {
  it('creates wa: prefixed thread ID', () => {
    expect(phoneToThreadId('+420777123456')).toBe('wa:+420777123456')
  })

  it('normalizes the phone number', () => {
    expect(phoneToThreadId('420 777 123 456')).toBe('wa:+420777123456')
  })
})
