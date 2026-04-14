/**
 * Layer 1: Route Protection Tests
 *
 * Verifies that every API route rejects unauthenticated requests.
 * If someone accidentally removes an auth check, these tests catch it.
 *
 * We test the auth-checking code paths WITHOUT hitting real services.
 * Each route handler is imported directly and called with fake NextRequest objects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NextRequest with the given method, URL, headers, and optional body */
function makeRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown
): NextRequest {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  return new NextRequest(new URL(url, 'http://localhost:3000'), init as never)
}

// ---------------------------------------------------------------------------
// Mock ALL downstream dependencies so route handlers never hit real services
// ---------------------------------------------------------------------------

// Supabase — every DB call returns empty/null
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'insert', 'update', 'delete', 'upsert',
        'eq', 'neq', 'in', 'lt', 'gt', 'gte', 'lte', 'not',
        'order', 'limit', 'range', 'is', 'filter', 'match']
      for (const m of methods) {
        chain[m] = vi.fn().mockReturnValue(chain)
      }
      chain.single = vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'not found' } })
      Object.defineProperty(chain, 'then', {
        value: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        writable: true, configurable: true,
      })
      return chain
    },
  }),
}))

// DB layer mocks
vi.mock('@/lib/db/users', () => ({
  getUserById: vi.fn().mockResolvedValue(null),
  getUserByEmail: vi.fn().mockResolvedValue(null),
  getUserSettings: vi.fn().mockResolvedValue({}),
  upsertUser: vi.fn().mockResolvedValue({ id: 'test', email: 'test@test.com' }),
  getUsersDueBrief: vi.fn().mockResolvedValue([]),
  updateUserGoogleTokens: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/db/actions', () => ({
  getActionById: vi.fn().mockResolvedValue(null),
  createAction: vi.fn().mockResolvedValue(null),
  updateAction: vi.fn().mockResolvedValue(null),
  updateActionDraft: vi.fn().mockResolvedValue(null),
  completeAction: vi.fn().mockResolvedValue(null),
  dismissAction: vi.fn().mockResolvedValue(null),
  dismissAllPendingActions: vi.fn().mockResolvedValue(0),
  calculatePriorityScore: vi.fn().mockReturnValue(0),
  getPendingActionsForBrief: vi.fn().mockResolvedValue([]),
  markActionsNotified: vi.fn().mockResolvedValue(undefined),
  getHighPriorityUnnotifiedActions: vi.fn().mockResolvedValue([]),
  markActionsInstantNotified: vi.fn().mockResolvedValue(undefined),
  hasPendingAction: vi.fn().mockResolvedValue(false),
  getActionsForUser: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/conversations', () => ({
  getConversationById: vi.fn().mockResolvedValue(null),
  getRecentMessages: vi.fn().mockResolvedValue([]),
  getParticipants: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/counterparties', () => ({
  getCPById: vi.fn().mockResolvedValue(null),
  blacklistCP: vi.fn().mockResolvedValue(null),
  findOrCreateCP: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/db/gdpr', () => ({
  deleteAllUserData: vi.fn().mockResolvedValue({}),
  exportAllUserData: vi.fn().mockResolvedValue({}),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/db/events', () => ({
  getEventsForToday: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/messages', () => ({
  getUnprocessedMessages: vi.fn().mockResolvedValue([]),
}))

// Service mocks
vi.mock('@/services/agent', () => ({
  runAgentForUser: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('@/services/morning-brief', () => ({
  sendMorningBrief: vi.fn().mockResolvedValue(true),
  sendAllMorningBriefs: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  sendInstantNotifications: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}))

vi.mock('@/services/ingestion', () => ({
  ingestEmailsForUser: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/services/threading', () => ({
  processMessagesForThreading: vi.fn().mockResolvedValue(new Map()),
}))

vi.mock('@/services/planning', () => ({
  generateActionsForConversations: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/services/scheduling', () => ({
  acceptInvitation: vi.fn().mockResolvedValue({ success: true }),
  declineInvitation: vi.fn().mockResolvedValue(undefined),
  confirmSlot: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/services/bulk-ingestion', () => ({
  runBulkIngestion: vi.fn().mockResolvedValue({ total: 0 }),
}))

vi.mock('@/lib/google/auth', () => ({
  getAuthorizationUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth'),
  exchangeCodeForTokens: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/google/gmail', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  getUserEmail: vi.fn().mockResolvedValue('test@test.com'),
}))

vi.mock('@/lib/google/calendar', () => ({
  createCalendarEvent: vi.fn().mockResolvedValue({}),
  confirmCalendarEvent: vi.fn().mockResolvedValue(undefined),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ai/tasks', () => ({}))

vi.mock('@/lib/ai/mila-voice', () => ({
  generateFinalDraft: vi.fn().mockResolvedValue({ subject: 'Test', body: 'Test body' }),
  generateBriefIntro: vi.fn().mockResolvedValue({ greeting: 'Test', subject: 'Test', headline: 'Test headline' }),
  generateUrgentIntro: vi.fn().mockResolvedValue({ subject: 'Test', header: 'Test', body: 'Test' }),
  generateLeadFollowUpIntent: vi.fn().mockResolvedValue({ intentCs: 'Test', rationaleCs: 'Test' }),
  generateSchedulingIntent: vi.fn().mockResolvedValue({ intent_cs: 'Test', missingInfo: [] }),
}))

vi.mock('@/lib/whatsapp/sender', () => ({
  getWhatsAppStatus: vi.fn().mockResolvedValue({ connected: false }),
}))

vi.mock('@/lib/auth/tokens', () => ({
  validateActionToken: vi.fn().mockReturnValue(false),
  validateBackfillToken: vi.fn().mockReturnValue(false),
  validateCronToken: vi.fn().mockReturnValue(false),
  validateOAuthState: vi.fn().mockReturnValue(null),
  validateTriggerToken: vi.fn().mockReturnValue(false),
  generateOAuthState: vi.fn().mockReturnValue('test-state'),
  generateActionToken: vi.fn().mockReturnValue('test-token'),
  generateBackfillToken: vi.fn().mockReturnValue('test-sig'),
  generateTriggerToken: vi.fn().mockReturnValue('test-sig'),
}))

vi.mock('uuid', () => ({
  v4: () => 'test-uuid',
}))

vi.mock('@/components/action/action-card-template', () => ({
  getActionCardEmailHtml: vi.fn().mockReturnValue('<div>test</div>'),
}))

vi.mock('@/config/theme', () => ({
  theme: {
    colors: { background: '#fff', surface: '#fff', text: '#000', textMuted: '#666', border: '#eee', primary: '#1e3a8a', secondary: '#f3f4f6', accent: '#b45309', success: '#059669', warning: '#d97706', error: '#dc2626', successBg: '#ecfdf5', warningBg: '#fffbeb', errorBg: '#fef2f2' },
    shadows: { card: 'none', hover: 'none', modal: 'none' },
    borderRadius: { sm: '4px', md: '8px', lg: '12px', full: '9999px' },
    typography: { fontFamily: 'sans-serif', sizes: { xs: '12px', sm: '14px', base: '16px', lg: '18px', xl: '20px', xxl: '24px' }, weights: { normal: 400, medium: 500, semibold: 600, bold: 700 } },
    spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px', xxl: '48px' },
  },
}))

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('MILA_USER_API_KEY', 'test-api-key-12345')
  vi.stubEnv('CRON_SECRET', 'test-cron-secret-12345')
  vi.stubEnv('NEXTAUTH_SECRET', 'test-nextauth-secret')
  vi.stubEnv('SUPERADMIN_KEY', 'test-superadmin-key')
  vi.stubEnv('NODE_ENV', 'production')
})

// ===========================================================================
// TESTS
// ===========================================================================

describe('Layer 1: Route Protection', () => {

  // -------------------------------------------------------------------------
  // Routes protected by API key (x-api-key header)
  // -------------------------------------------------------------------------

  describe('API Key protected routes', () => {

    it('POST /api/agent/run — rejects without API key', async () => {
      const { POST } = await import('@/app/api/agent/run/route')
      const req = makeRequest('POST', '/api/agent/run', {}, { userId: 'test' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/agent/run — rejects with wrong API key', async () => {
      const { POST } = await import('@/app/api/agent/run/route')
      const req = makeRequest('POST', '/api/agent/run', { 'x-api-key': 'wrong-key' }, { userId: 'test' })
      const res = await POST(req)
      expect(res.status).toBe(403)
    })

    it('POST /api/gdpr/delete — rejects without API key', async () => {
      const { POST } = await import('@/app/api/gdpr/delete/route')
      const req = makeRequest('POST', '/api/gdpr/delete', {}, { userId: 'test' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/gdpr/delete — rejects with wrong API key', async () => {
      const { POST } = await import('@/app/api/gdpr/delete/route')
      const req = makeRequest('POST', '/api/gdpr/delete', { 'x-api-key': 'wrong-key' }, { userId: 'test' })
      const res = await POST(req)
      expect(res.status).toBe(403)
    })

    it('GET /api/gdpr/export — rejects without API key', async () => {
      const { GET } = await import('@/app/api/gdpr/export/route')
      const req = makeRequest('GET', '/api/gdpr/export?userId=test')
      const res = await GET(req)
      expect(res.status).toBe(401)
    })

    it('GET /api/gdpr/export — rejects with wrong API key', async () => {
      const { GET } = await import('@/app/api/gdpr/export/route')
      const req = makeRequest('GET', '/api/gdpr/export?userId=test', { 'x-api-key': 'wrong-key' })
      const res = await GET(req)
      expect(res.status).toBe(403)
    })

    it('POST /api/ingest — rejects without any auth (no userId, no cronToken)', async () => {
      const { POST } = await import('@/app/api/ingest/route')
      const req = makeRequest('POST', '/api/ingest', {}, {})
      const res = await POST(req)
      expect(res.status).toBe(400)
    })

    it('POST /api/ingest — rejects userId without API key', async () => {
      const { POST } = await import('@/app/api/ingest/route')
      const req = makeRequest('POST', '/api/ingest', {}, { userId: 'test' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/ingest — rejects bad cronToken', async () => {
      const { POST } = await import('@/app/api/ingest/route')
      const req = makeRequest('POST', '/api/ingest', {}, { cronToken: 'bad-token' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/ingest/bulk — rejects without API key', async () => {
      const { POST } = await import('@/app/api/ingest/bulk/route')
      const req = makeRequest('POST', '/api/ingest/bulk', {}, { userId: 'test', since: '2024-01-01' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/ingest/bulk — rejects with wrong API key', async () => {
      const { POST } = await import('@/app/api/ingest/bulk/route')
      const req = makeRequest('POST', '/api/ingest/bulk', { 'x-api-key': 'wrong-key' }, { userId: 'test', since: '2024-01-01' })
      const res = await POST(req)
      expect(res.status).toBe(403)
    })

    it('GET /api/whatsapp/status — rejects without API key', async () => {
      const { GET } = await import('@/app/api/whatsapp/status/route')
      const req = makeRequest('GET', '/api/whatsapp/status?userId=test')
      const res = await GET(req)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Routes protected by Cron token (Bearer header)
  // -------------------------------------------------------------------------

  describe('Cron token protected routes', () => {

    it('GET /api/cron/morning-brief — rejects without token', async () => {
      const { GET } = await import('@/app/api/cron/morning-brief/route')
      const req = makeRequest('GET', '/api/cron/morning-brief')
      const res = await GET(req)
      expect(res.status).toBe(401)
    })

    it('GET /api/cron/morning-brief — rejects with bad token', async () => {
      const { GET } = await import('@/app/api/cron/morning-brief/route')
      const req = makeRequest('GET', '/api/cron/morning-brief', { authorization: 'Bearer wrong-token' })
      const res = await GET(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/cron/morning-brief — same protection as GET', async () => {
      const { POST } = await import('@/app/api/cron/morning-brief/route')
      const req = makeRequest('POST', '/api/cron/morning-brief')
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('GET /api/cron/instant-notify — rejects without token', async () => {
      const { GET } = await import('@/app/api/cron/instant-notify/route')
      const req = makeRequest('GET', '/api/cron/instant-notify')
      const res = await GET(req)
      expect(res.status).toBe(401)
    })

    it('GET /api/cron/instant-notify — rejects with bad token', async () => {
      const { GET } = await import('@/app/api/cron/instant-notify/route')
      const req = makeRequest('GET', '/api/cron/instant-notify', { authorization: 'Bearer wrong-token' })
      const res = await GET(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/cron/instant-notify — same protection as GET', async () => {
      const { POST } = await import('@/app/api/cron/instant-notify/route')
      const req = makeRequest('POST', '/api/cron/instant-notify')
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/ingest/bulk/worker — rejects without cron token', async () => {
      const { POST } = await import('@/app/api/ingest/bulk/worker/route')
      const req = makeRequest('POST', '/api/ingest/bulk/worker', {}, { step: 'phase1_inbox', userId: 'test' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })

    it('POST /api/ingest/bulk/worker — rejects with bad cron token', async () => {
      const { POST } = await import('@/app/api/ingest/bulk/worker/route')
      const req = makeRequest('POST', '/api/ingest/bulk/worker', { authorization: 'Bearer wrong-token' }, { step: 'phase1_inbox', userId: 'test' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Routes protected by Action token (HMAC-signed)
  // -------------------------------------------------------------------------

  describe('Action token protected routes', () => {

    it('GET /api/action/[id] — rejects without token', async () => {
      const { GET } = await import('@/app/api/action/[id]/route')
      const req = makeRequest('GET', '/api/action/test-id')
      const params = Promise.resolve({ id: 'test-id' })
      const res = await GET(req, { params })
      expect(res.status).toBe(401)
    })

    it('GET /api/action/[id] — rejects with bad token (action not found)', async () => {
      const { GET } = await import('@/app/api/action/[id]/route')
      const req = makeRequest('GET', '/api/action/test-id?token=bad-token')
      const params = Promise.resolve({ id: 'test-id' })
      const res = await GET(req, { params })
      // Action not found returns 404 before token validation
      expect([401, 404]).toContain(res.status)
    })

    it('POST /api/action/[id]/execute — rejects without token', async () => {
      const { POST } = await import('@/app/api/action/[id]/execute/route')
      const req = makeRequest('POST', '/api/action/test-id/execute', {}, {})
      const params = Promise.resolve({ id: 'test-id' })
      const res = await POST(req, { params })
      expect(res.status).toBe(401)
    })

    it('PUT /api/action/[id]/draft — rejects without token', async () => {
      const { PUT } = await import('@/app/api/action/[id]/draft/route')
      const req = makeRequest('PUT', '/api/action/test-id/draft', {}, { subject: 'test' })
      const params = Promise.resolve({ id: 'test-id' })
      const res = await PUT(req, { params })
      expect(res.status).toBe(401)
    })

    it('POST /api/action/[id]/blacklist — rejects without token', async () => {
      const { POST } = await import('@/app/api/action/[id]/blacklist/route')
      const req = makeRequest('POST', '/api/action/test-id/blacklist', {}, {})
      const params = Promise.resolve({ id: 'test-id' })
      const res = await POST(req, { params })
      expect(res.status).toBe(401)
    })

    it('POST /api/action/[id]/todo — rejects without token', async () => {
      const { POST } = await import('@/app/api/action/[id]/todo/route')
      const req = makeRequest('POST', '/api/action/test-id/todo', {}, {})
      const params = Promise.resolve({ id: 'test-id' })
      const res = await POST(req, { params })
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Superadmin route
  // -------------------------------------------------------------------------

  describe('Superadmin protected routes', () => {

    it('GET /api/superadmin/stats — rejects without key', async () => {
      const { GET } = await import('@/app/api/superadmin/stats/route')
      const req = makeRequest('GET', '/api/superadmin/stats')
      const res = await GET(req)
      expect(res.status).toBe(401)
    })

    it('GET /api/superadmin/stats — rejects with wrong key', async () => {
      const { GET } = await import('@/app/api/superadmin/stats/route')
      const req = makeRequest('GET', '/api/superadmin/stats?key=wrong-key')
      const res = await GET(req)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Trigger route — deprecated, returns GIF only (no agent run)
  // -------------------------------------------------------------------------

  describe('Trigger route (deprecated)', () => {

    it('GET /api/trigger/ingest — returns GIF without running agent', async () => {
      const { GET } = await import('@/app/api/trigger/ingest/route')
      const res = await GET()
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/gif')
    })
  })

  // -------------------------------------------------------------------------
  // Auth routes — public but with validation
  // -------------------------------------------------------------------------

  describe('Auth routes (public but validated)', () => {

    it('POST /api/auth/connect — rejects without email', async () => {
      const { POST } = await import('@/app/api/auth/connect/route')
      const req = makeRequest('POST', '/api/auth/connect', {}, {})
      const res = await POST(req)
      expect(res.status).toBe(400)
    })

    it('POST /api/auth/connect — rejects invalid email format', async () => {
      const { POST } = await import('@/app/api/auth/connect/route')
      const req = makeRequest('POST', '/api/auth/connect', {}, { email: 'not-an-email' })
      const res = await POST(req)
      expect(res.status).toBe(400)
    })

    it('POST /api/auth/callback — rejects without code or state', async () => {
      const { POST } = await import('@/app/api/auth/callback/route')
      const req = makeRequest('POST', '/api/auth/callback', {}, {})
      const res = await POST(req)
      expect(res.status).toBe(400)
    })

    it('POST /api/auth/callback — rejects with invalid state', async () => {
      const { POST } = await import('@/app/api/auth/callback/route')
      const req = makeRequest('POST', '/api/auth/callback', {}, { code: 'test-code', state: 'bad-state' })
      const res = await POST(req)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Backfill report action route — signed token
  // -------------------------------------------------------------------------

  describe('Backfill action route (signed token)', () => {

    it('GET /api/backfill/action — rejects without params', async () => {
      const { GET } = await import('@/app/api/backfill/action/route')
      const req = makeRequest('GET', '/api/backfill/action')
      const res = await GET(req)
      expect(res.status).toBe(400)
    })

    it('GET /api/backfill/action — rejects with bad signature', async () => {
      const { GET } = await import('@/app/api/backfill/action/route')
      const req = makeRequest('GET', '/api/backfill/action?uid=test&op=allow&target=test%40test.com&sig=bad-sig')
      const res = await GET(req)
      expect(res.status).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Health — public, no auth needed
  // -------------------------------------------------------------------------

  describe('Health endpoint (public)', () => {

    it('GET /api/health — responds (no auth required)', async () => {
      const { GET } = await import('@/app/api/health/route')
      const res = await GET()
      // May return 200 or 503 depending on env, but should not be 401/403
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })
  })
})
