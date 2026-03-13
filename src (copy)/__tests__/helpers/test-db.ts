/**
 * Test Database Helpers — Real Supabase Operations
 *
 * Used by integration tests that mock only AI + external APIs.
 * All operations hit the real database via getSupabaseAdmin().
 *
 * Tests are gated: if SUPABASE_URL is not available, they skip.
 */

import { getSupabaseAdmin } from '@/lib/supabase/client'
import { DEFAULT_USER_SETTINGS } from '@/lib/supabase/types'
import { v4 as uuidv4 } from 'uuid'

// Fixed test user UUID — clearly recognizable, valid v4 format
export const TEST_USER_ID = '00000000-0000-4000-a000-000000000001'
export const TEST_USER_EMAIL = 'mila-integration-test@test.local'

/**
 * Check if real database is available for integration tests.
 * Tests use: describe.skipIf(!HAS_DB)(...)
 */
export const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY && process.env.RUN_DB_TESTS)

function db() {
  return getSupabaseAdmin()
}

// ─── Setup Helpers ──────────────────────────────────────────────────────────

export async function setupTestUser(overrides: Record<string, unknown> = {}) {
  await cleanupTestData()

  const { data, error } = await db()
    .from('users')
    .upsert({
      id: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      mila_name: 'Integration Test User',
      public_name: 'Test User',
      email_timezone: 'Europe/Prague',
      email_enabled: true,
      email_unsubscribed: false,
      settings: DEFAULT_USER_SETTINGS,
      google_oauth_tokens: { access_token: 'test-token', refresh_token: 'test-refresh' },
      ...overrides,
    }, { onConflict: 'id' })
    .select()
    .single()

  if (error) throw new Error(`setupTestUser: ${error.message}`)
  return data
}

export async function createTestCP(overrides: Record<string, unknown> = {}) {
  const { data, error } = await db()
    .from('cps')
    .insert({
      id: uuidv4(),
      user_id: TEST_USER_ID,
      name: 'Jan Novák',
      primary_identifier: 'jan@example.com',
      role: 'buyer',
      is_blacklisted: false,
      ...overrides,
    })
    .select()
    .single()

  if (error) throw new Error(`createTestCP: ${error.message}`)
  return data
}

export async function createTestConversation(overrides: Record<string, unknown> = {}) {
  const { data, error } = await db()
    .from('conversation_threads')
    .insert({
      id: uuidv4(),
      user_id: TEST_USER_ID,
      topic: 'Byt Vinohrady 3+kk',
      summary_text: 'Jan Novák má zájem o koupi bytu na Vinohradech za 8.5M CZK.',
      summary_json: {
        currentState: 'Zájem projevil',
        nextSteps: ['Domluvit prohlídku'],
        keyPoints: ['8.5M CZK', 'Vinohrady 3+kk'],
        risks: [],
        confidence: 0.85,
        confidenceReason: 'Clear deal progression with concrete price',
        dealType: 'sale',
      },
      summary_confidence: 0.85,
      summary_confidence_reason: 'Clear deal progression',
      messages_since_rebuild: 0,
      message_count: 0,
      state: 'active',
      deal_type: 'sale',
      priority_score: 50,
      ...overrides,
    })
    .select()
    .single()

  if (error) throw new Error(`createTestConversation: ${error.message}`)
  return data
}

export async function createTestMessage(overrides: Record<string, unknown> = {}) {
  const msgId = uuidv4()
  const { data, error } = await db()
    .from('messages')
    .insert({
      id: msgId,
      user_id: TEST_USER_ID,
      direction: 'inbound',
      raw_text: 'Dobrý den, mám zájem o byt na Vinohradech za 8.5M CZK.',
      cleaned_text: 'Dobrý den, mám zájem o byt na Vinohradech za 8.5M CZK.',
      enriched_text: 'Zájemce: Jan Novák. Nemovitost: byt Vinohrady 3+kk. Cena: 8.5M CZK. Zájem o prohlídku.',
      channel_id: null,
      universal_message_id: msgId,
      tag_primary: 'inquiry',
      tag_secondary: 'high',
      timestamp: new Date().toISOString(),
      occurred_at: new Date().toISOString(),
      ...overrides,
    })
    .select()
    .single()

  if (error) throw new Error(`createTestMessage: ${error.message}`)
  return data
}

export async function createTestAction(overrides: Record<string, unknown> = {}) {
  // Auto-create CP and conversation if not provided (FK constraints require them)
  if (!overrides.cp_id) {
    const cp = await createTestCP()
    overrides = { ...overrides, cp_id: cp.id }
  }
  if (!overrides.conversation_id) {
    const conv = await createTestConversation()
    overrides = { ...overrides, conversation_id: conv.id }
  }

  const { data, error } = await db()
    .from('action_proposals')
    .insert({
      id: uuidv4(),
      user_id: TEST_USER_ID,
      action_type: 'REPLY',
      status: 'pending',
      rationale: 'Reply to apartment inquiry',
      rationale_cs: 'Odpovědět na poptávku bytu',
      intent_cs: 'Nabídnout prohlídku bytu na Vinohradech',
      priority_score: 75,
      urgency: 7,

      dollar_value: 8500000,
      weight: 40,
      offer_multiplier: 1.0,
      queued_for_brief: true,
      payload: { channel: 'email' },
      ...overrides,
    })
    .select()
    .single()

  if (error) throw new Error(`createTestAction: ${error.message}`)
  return data
}

// ─── Cleanup (FK-safe order, mirrors GDPR cascade) ─────────────────────────

export async function cleanupTestData() {
  const supabase = db()

  const { data: cps } = await supabase.from('cps').select('id').eq('user_id', TEST_USER_ID)
  const cpIds = (cps || []).map((c: { id: string }) => c.id)

  const { data: msgs } = await supabase.from('messages').select('id').eq('user_id', TEST_USER_ID)
  const msgIds = (msgs || []).map((m: { id: string }) => m.id)

  const { data: convs } = await supabase.from('conversation_threads').select('id').eq('user_id', TEST_USER_ID)
  const convIds = (convs || []).map((c: { id: string }) => c.id)

  await supabase.from('emails').delete().eq('user_id', TEST_USER_ID)
  if (msgIds.length > 0) {
    await supabase.from('message_embeddings').delete().in('message_id', msgIds)
  }
  await supabase.from('action_proposals').delete().eq('user_id', TEST_USER_ID)
  if (convIds.length > 0) {
    await supabase.from('thread_participants').delete().in('thread_id', convIds)
  }
  await supabase.from('messages').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('todos').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('events').delete().eq('user_id', TEST_USER_ID)
  if (cpIds.length > 0) {
    await supabase.from('cp_states').delete().in('cp_id', cpIds)
  }
  await supabase.from('conversation_threads').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('cps').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('channels').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('agent_errors').delete().eq('user_id', TEST_USER_ID)
  try {
    await supabase.from('user_agent_locks').delete().eq('user_id', TEST_USER_ID)
  } catch { /* table may not exist yet */ }
}

// ─── Read Helpers (for assertions) ──────────────────────────────────────────

export async function getTestActions() {
  const { data } = await db()
    .from('action_proposals')
    .select('*')
    .eq('user_id', TEST_USER_ID)
    .order('created_at', { ascending: false })
  return data || []
}

export async function getTestMessages() {
  const { data } = await db()
    .from('messages')
    .select('*')
    .eq('user_id', TEST_USER_ID)
    .order('timestamp', { ascending: true })
  return data || []
}

export async function getTestConversations() {
  const { data } = await db()
    .from('conversation_threads')
    .select('*')
    .eq('user_id', TEST_USER_ID)
    .order('created_at', { ascending: false })
  return data || []
}

export async function getTestConversation(id: string) {
  const { data } = await db()
    .from('conversation_threads')
    .select('*')
    .eq('id', id)
    .single()
  return data
}

export async function getTestCPs() {
  const { data } = await db()
    .from('cps')
    .select('*')
    .eq('user_id', TEST_USER_ID)
  return data || []
}
