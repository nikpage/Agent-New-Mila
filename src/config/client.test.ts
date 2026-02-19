import { describe, it, expect } from 'vitest'
import { getAISystemPrompt, containsHighValueSignals, isPersonalEvent } from './client'
import type { UserSettings } from '@/lib/supabase/types'

/** Minimal UserSettings stub with only the fields these functions read */
function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    // Client identity
    client_name: 'Test User',
    client_company: 'Test Corp',
    client_role: 'Agent',
    client_phone: '+420111222333',
    client_whatsapp: '+420111222333',
    // Business context
    business_type: 'real_estate',
    business_market: 'Prague residential',
    business_specialization: 'Luxury apartments',
    typical_deal_size_min: 3_000_000,
    typical_deal_size_max: 25_000_000,
    typical_deal_size_currency: 'CZK',
    high_value_signals: ['penthouse', 'investment', 'exclusive'],
    low_priority_signals: ['newsletter', 'unsubscribe'],
    // AI persona
    ai_name: 'Mila',
    ai_language: 'cs',
    ai_email_signature: '',
    ai_system_context: 'You assist Test User, a real estate agent.',
    ai_tone_user: 'professional',
    ai_tone_cp: 'polite and formal',
    user_alias: 'User',
    // Schedule
    timezone: 'Europe/Prague',
    working_hours_start: 9,
    working_hours_end: 17,
    working_days: [1, 2, 3, 4, 5],
    morning_brief_time: '08:00',
    afternoon_brief_time: '13:00',
    // Meetings
    default_meeting_duration: 30,
    default_meeting_type: 'online',
    meeting_buffer_minutes: 15,
    travel_mode: 'driving',
    home_location: '',
    office_location: '',
    // Scoring
    offer_multiplier_seller: 1.5,
    offer_multiplier_buyer: 1.0,
    priority_multiplier_vip: 2.0,
    kc_factor: 13,
    default_delegate_email: null,
    todo_auto_due_days: 1,
    // Lead management
    cooling_threshold_days: 2,
    cold_threshold_days: 5,
    dead_threshold_days: 14,
    max_auto_follow_ups: 3,
    cooling_priority_boost: 1.5,
    cold_priority_boost: 2.5,
    min_deal_value_for_tracking: 0,
    // Calendar
    business_calendar_id: 'primary',
    personal_calendar_id: null,
    personal_event_keywords: ['osobní', 'personal', 'rodina', 'lékař', 'doctor', 'gym', 'vacation'],
    // WhatsApp
    whatsapp_enabled: false,
    whatsapp_session_data_path: './baileys_auth',
    whatsapp_daemon_port: 3001,
    whatsapp_auto_ack_message: null,
    whatsapp_blocked_numbers: [],
    whatsapp_monitored_groups: [],
    ...overrides,
  } as UserSettings
}

describe('getAISystemPrompt', () => {
  it('includes user business context', () => {
    const prompt = getAISystemPrompt(makeSettings())
    expect(prompt).toContain('Test Corp')
    expect(prompt).toContain('Luxury apartments')
    expect(prompt).toContain('Prague residential')
  })

  it('includes deal size range', () => {
    const prompt = getAISystemPrompt(makeSettings())
    expect(prompt).toContain('3,000,000')
    expect(prompt).toContain('25,000,000')
    expect(prompt).toContain('CZK')
  })

  it('includes high-value signals', () => {
    const prompt = getAISystemPrompt(makeSettings())
    expect(prompt).toContain('penthouse')
    expect(prompt).toContain('investment')
  })

  it('includes language setting', () => {
    const prompt = getAISystemPrompt(makeSettings({ ai_language: 'cs' }))
    expect(prompt).toContain('Czech')
  })

  it('includes tone with counterparties', () => {
    const prompt = getAISystemPrompt(makeSettings())
    expect(prompt).toContain('polite and formal')
  })
})

describe('containsHighValueSignals', () => {
  const settings = makeSettings()

  it('detects exact keyword', () => {
    expect(containsHighValueSignals('I want a penthouse', settings)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(containsHighValueSignals('PENTHOUSE please', settings)).toBe(true)
    expect(containsHighValueSignals('Investment opportunity', settings)).toBe(true)
  })

  it('detects keyword inside longer text', () => {
    expect(containsHighValueSignals('This is an exclusive listing on the market', settings)).toBe(true)
  })

  it('returns false when no signals match', () => {
    expect(containsHighValueSignals('Just a normal apartment inquiry', settings)).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(containsHighValueSignals('', settings)).toBe(false)
  })

  it('handles empty signals list', () => {
    const noSignals = makeSettings({ high_value_signals: [] })
    expect(containsHighValueSignals('penthouse', noSignals)).toBe(false)
  })
})

describe('isPersonalEvent', () => {
  const settings = makeSettings()

  it('detects personal event keywords', () => {
    expect(isPersonalEvent('Lékař - prohlídka', settings)).toBe(true)
    expect(isPersonalEvent('Gym session', settings)).toBe(true)
    expect(isPersonalEvent('Personal errand', settings)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isPersonalEvent('DOCTOR appointment', settings)).toBe(true)
    expect(isPersonalEvent('OSOBNÍ věc', settings)).toBe(true)
  })

  it('returns false for business events', () => {
    expect(isPersonalEvent('Client meeting at Starbucks', settings)).toBe(false)
    expect(isPersonalEvent('Property viewing', settings)).toBe(false)
  })

  it('returns false for empty title', () => {
    expect(isPersonalEvent('', settings)).toBe(false)
  })
})
