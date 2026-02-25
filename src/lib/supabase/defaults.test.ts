/**
 * Layer 2: DEFAULT_USER_SETTINGS Snapshot
 *
 * This is the single most important behavior-pinning test.
 * If ANYONE changes ANY default setting value — scoring multipliers,
 * thresholds, working hours, AI config, ANYTHING — this test fails.
 *
 * Every field is pinned with its exact expected value.
 * Changing a default requires updating this test, which forces a conscious decision.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_USER_SETTINGS } from '@/lib/supabase/types'

describe('DEFAULT_USER_SETTINGS — Full Snapshot', () => {

  // -------------------------------------------------------------------------
  // Working Hours & Timezone
  // -------------------------------------------------------------------------

  it('working_hours_start = 9', () => {
    expect(DEFAULT_USER_SETTINGS.working_hours_start).toBe(9)
  })

  it('working_hours_end = 17', () => {
    expect(DEFAULT_USER_SETTINGS.working_hours_end).toBe(17)
  })

  it('working_days = Mon-Fri [1,2,3,4,5]', () => {
    expect(DEFAULT_USER_SETTINGS.working_days).toEqual([1, 2, 3, 4, 5])
  })

  it('timezone = Europe/Prague', () => {
    expect(DEFAULT_USER_SETTINGS.timezone).toBe('Europe/Prague')
  })

  it('morning_brief_time = 08:00', () => {
    expect(DEFAULT_USER_SETTINGS.morning_brief_time).toBe('08:00')
  })

  it('afternoon_brief_time = 13:00', () => {
    expect(DEFAULT_USER_SETTINGS.afternoon_brief_time).toBe('13:00')
  })

  // -------------------------------------------------------------------------
  // Meeting Preferences
  // -------------------------------------------------------------------------

  it('default_meeting_duration = 30', () => {
    expect(DEFAULT_USER_SETTINGS.default_meeting_duration).toBe(30)
  })

  it('default_meeting_type = online', () => {
    expect(DEFAULT_USER_SETTINGS.default_meeting_type).toBe('online')
  })

  it('meeting_buffer_minutes = 15', () => {
    expect(DEFAULT_USER_SETTINGS.meeting_buffer_minutes).toBe(15)
  })

  // -------------------------------------------------------------------------
  // Travel
  // -------------------------------------------------------------------------

  it('travel_mode = driving', () => {
    expect(DEFAULT_USER_SETTINGS.travel_mode).toBe('driving')
  })

  it('home_location = empty string', () => {
    expect(DEFAULT_USER_SETTINGS.home_location).toBe('')
  })

  it('office_location = empty string', () => {
    expect(DEFAULT_USER_SETTINGS.office_location).toBe('')
  })

  // -------------------------------------------------------------------------
  // Priority / Scoring
  // -------------------------------------------------------------------------

  it('offer_multiplier_seller = 1.5', () => {
    expect(DEFAULT_USER_SETTINGS.offer_multiplier_seller).toBe(1.5)
  })

  it('offer_multiplier_buyer = 1.0', () => {
    expect(DEFAULT_USER_SETTINGS.offer_multiplier_buyer).toBe(1.0)
  })

  it('priority_multiplier_vip = 2.0', () => {
    expect(DEFAULT_USER_SETTINGS.priority_multiplier_vip).toBe(2.0)
  })

  it('kc_low_value = 500000', () => {
    expect(DEFAULT_USER_SETTINGS.kc_low_value).toBe(500_000)
  })

  it('kc_high_value = 5000000', () => {
    expect(DEFAULT_USER_SETTINGS.kc_high_value).toBe(5_000_000)
  })

  // -------------------------------------------------------------------------
  // Delegation
  // -------------------------------------------------------------------------

  it('default_delegate_email = null', () => {
    expect(DEFAULT_USER_SETTINGS.default_delegate_email).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Todos
  // -------------------------------------------------------------------------

  it('todo_auto_due_days = 1', () => {
    expect(DEFAULT_USER_SETTINGS.todo_auto_due_days).toBe(1)
  })

  // -------------------------------------------------------------------------
  // AI Persona
  // -------------------------------------------------------------------------

  it('ai_tone_user = professional and concise', () => {
    expect(DEFAULT_USER_SETTINGS.ai_tone_user).toBe('professional and concise')
  })

  it('ai_tone_cp = polite and formal', () => {
    expect(DEFAULT_USER_SETTINGS.ai_tone_cp).toBe('polite and formal')
  })

  it('user_alias = User', () => {
    expect(DEFAULT_USER_SETTINGS.user_alias).toBe('User')
  })

  it('ai_name = Mila', () => {
    expect(DEFAULT_USER_SETTINGS.ai_name).toBe('Mila')
  })

  it('ai_language = cs', () => {
    expect(DEFAULT_USER_SETTINGS.ai_language).toBe('cs')
  })

  it('ai_email_signature = empty string', () => {
    expect(DEFAULT_USER_SETTINGS.ai_email_signature).toBe('')
  })

  it('ai_system_context = empty string', () => {
    expect(DEFAULT_USER_SETTINGS.ai_system_context).toBe('')
  })

  // -------------------------------------------------------------------------
  // Lead Management
  // -------------------------------------------------------------------------

  it('cooling_threshold_days = 2', () => {
    expect(DEFAULT_USER_SETTINGS.cooling_threshold_days).toBe(2)
  })

  it('cold_threshold_days = 5', () => {
    expect(DEFAULT_USER_SETTINGS.cold_threshold_days).toBe(5)
  })

  it('dead_threshold_days = 14', () => {
    expect(DEFAULT_USER_SETTINGS.dead_threshold_days).toBe(14)
  })

  it('max_auto_follow_ups = 3', () => {
    expect(DEFAULT_USER_SETTINGS.max_auto_follow_ups).toBe(3)
  })

  it('cooling_priority_boost = 1.5', () => {
    expect(DEFAULT_USER_SETTINGS.cooling_priority_boost).toBe(1.5)
  })

  it('cold_priority_boost = 2.5', () => {
    expect(DEFAULT_USER_SETTINGS.cold_priority_boost).toBe(2.5)
  })

  it('min_deal_value_for_tracking = 0', () => {
    expect(DEFAULT_USER_SETTINGS.min_deal_value_for_tracking).toBe(0)
  })

  // -------------------------------------------------------------------------
  // WhatsApp
  // -------------------------------------------------------------------------

  it('whatsapp_enabled = false', () => {
    expect(DEFAULT_USER_SETTINGS.whatsapp_enabled).toBe(false)
  })

  it('whatsapp_session_data_path = ./baileys_auth', () => {
    expect(DEFAULT_USER_SETTINGS.whatsapp_session_data_path).toBe('./baileys_auth')
  })

  it('whatsapp_daemon_port = 3001', () => {
    expect(DEFAULT_USER_SETTINGS.whatsapp_daemon_port).toBe(3001)
  })

  it('whatsapp_auto_ack_message = null', () => {
    expect(DEFAULT_USER_SETTINGS.whatsapp_auto_ack_message).toBeNull()
  })

  it('whatsapp_blocked_numbers = empty array', () => {
    expect(DEFAULT_USER_SETTINGS.whatsapp_blocked_numbers).toEqual([])
  })

  it('whatsapp_monitored_groups = empty array', () => {
    expect(DEFAULT_USER_SETTINGS.whatsapp_monitored_groups).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Calendar
  // -------------------------------------------------------------------------

  it('business_calendar_id = primary', () => {
    expect(DEFAULT_USER_SETTINGS.business_calendar_id).toBe('primary')
  })

  it('personal_calendar_id = null', () => {
    expect(DEFAULT_USER_SETTINGS.personal_calendar_id).toBeNull()
  })

  it('personal_event_keywords contains expected keywords', () => {
    const kw = DEFAULT_USER_SETTINGS.personal_event_keywords
    expect(Array.isArray(kw)).toBe(true)
    expect(kw.length).toBe(21)
    // Spot-check key entries
    expect(kw).toContain('osobní')
    expect(kw).toContain('personal')
    expect(kw).toContain('lékař')
    expect(kw).toContain('doctor')
    expect(kw).toContain('dovolená')
    expect(kw).toContain('vacation')
  })

  // -------------------------------------------------------------------------
  // QStash
  // -------------------------------------------------------------------------

  it('qstash_morning_schedule_id = null', () => {
    expect(DEFAULT_USER_SETTINGS.qstash_morning_schedule_id).toBeNull()
  })

  it('qstash_afternoon_schedule_id = null', () => {
    expect(DEFAULT_USER_SETTINGS.qstash_afternoon_schedule_id).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Business context defaults (empty — filled per user)
  // -------------------------------------------------------------------------

  it('client identity fields are empty strings', () => {
    expect(DEFAULT_USER_SETTINGS.client_name).toBe('')
    expect(DEFAULT_USER_SETTINGS.client_company).toBe('')
    expect(DEFAULT_USER_SETTINGS.client_role).toBe('')
    expect(DEFAULT_USER_SETTINGS.client_phone).toBe('')
    expect(DEFAULT_USER_SETTINGS.client_whatsapp).toBe('')
  })

  it('business context fields are empty/zero', () => {
    expect(DEFAULT_USER_SETTINGS.business_type).toBe('')
    expect(DEFAULT_USER_SETTINGS.business_market).toBe('')
    expect(DEFAULT_USER_SETTINGS.business_specialization).toBe('')
    expect(DEFAULT_USER_SETTINGS.typical_deal_size_min).toBe(0)
    expect(DEFAULT_USER_SETTINGS.typical_deal_size_max).toBe(0)
    expect(DEFAULT_USER_SETTINGS.typical_deal_size_currency).toBe('CZK')
  })

  it('signal arrays are empty', () => {
    expect(DEFAULT_USER_SETTINGS.high_value_signals).toEqual([])
    expect(DEFAULT_USER_SETTINGS.low_priority_signals).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Structural: no fields added or removed without updating this test
  // -------------------------------------------------------------------------

  it('has exactly the expected number of fields', () => {
    const fieldCount = Object.keys(DEFAULT_USER_SETTINGS).length
    // If you add a new field to UserSettings, add a test above AND update this count
    expect(fieldCount).toBe(57)
  })
})
