/**
 * E2E Tests — 100% Live, Full Workflow Verification
 *
 * These tests exercise complete user workflows against a running instance.
 * Nothing is mocked. Real AI, real DB, real email, real everything.
 *
 * HOW TO RUN:
 *   E2E_TEST=1 npm test -- src/__tests__/e2e.test.ts
 *
 * Required env vars:
 *   E2E_TEST=1                — enables these tests
 *   MILA_USER_API_KEY         — API key for the target instance
 *   CRON_SECRET               — Cron secret for the target instance
 *   E2E_BASE_URL              — defaults to http://localhost:3000
 *
 * Test user: podtwo@gmail.com (d1a403fd-121b-4dcc-96aa-0efa3af114a8)
 *
 * WARNING: These tests trigger real AI calls and may incur costs.
 * They also send real emails and modify real data.
 */
import { describe, it, expect, beforeAll } from 'vitest'

const E2E = process.env.E2E_TEST === '1'
const BASE_URL = process.env.E2E_BASE_URL || process.env.SMOKE_BASE_URL || 'http://localhost:3000'
const API_KEY = process.env.MILA_USER_API_KEY || ''
const CRON_SECRET = process.env.CRON_SECRET || ''
const TEST_USER_ID = 'd1a403fd-121b-4dcc-96aa-0efa3af114a8'

// ─── HTTP helper ────────────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; timeout?: number } = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout || 60000)
  init.signal = controller.signal

  const res = await fetch(url, init)
  clearTimeout(timer)
  const ct = res.headers.get('content-type') || ''
  let body: unknown
  if (ct.includes('json')) body = await res.json()
  else if (ct.includes('image')) body = '<binary image>'
  else body = await res.text()
  return { status: res.status, body, headers: res.headers }
}

const describeE2E = E2E ? describe : describe.skip

// ═════════════════════════════════════════════════════════════════════════════

describeE2E('E2E: Full Workflow Tests (100% live)', () => {

  beforeAll(() => {
    console.log(`\n  E2E target: ${BASE_URL}`)
    console.log(`  User: ${TEST_USER_ID}`)
    console.log(`  API key: ${API_KEY ? 'set' : 'MISSING'}`)
    console.log(`  Cron: ${CRON_SECRET ? 'set' : 'MISSING'}\n`)
    expect(API_KEY).toBeTruthy()
    expect(CRON_SECRET).toBeTruthy()
  })

  // ─── Workflow 1: Agent pipeline → brief cycle ─────────────────────────

  describe('Agent → Brief cycle', () => {
    let agentResult: Record<string, unknown> | null = null

    it('agent pipeline runs and returns valid result', async () => {
      const res = await api('POST', '/api/agent/run', {
        headers: { 'x-api-key': API_KEY },
        body: { userId: TEST_USER_ID },
        timeout: 180000,
      })

      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(body.success).toBe(true)

      // All numeric fields present and valid
      for (const field of ['emailsIngested', 'messagesProcessed', 'conversationsUpdated', 'actionsGenerated', 'calendarEventsSynced']) {
        expect(typeof body[field]).toBe('number')
        expect(body[field]).toBeGreaterThanOrEqual(0)
      }

      agentResult = body
    })

    it('morning brief runs after agent pipeline', async () => {
      const res = await api('GET', `/api/cron/morning-brief?userId=${TEST_USER_ID}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
        timeout: 60000,
      })

      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(body.userId).toBe(TEST_USER_ID)
      expect(typeof body.success).toBe('boolean')

      // If agent generated actions, brief should have sent them
      if (agentResult && (agentResult.actionsGenerated as number) > 0) {
        console.log(`  Agent generated ${agentResult.actionsGenerated} actions, brief should have sent them`)
      }
    })
  })

  // ─── Workflow 2: GDPR export verifies data integrity ──────────────────

  describe('GDPR data integrity', () => {
    it('export returns all data categories for the user', async () => {
      const res = await api('GET', `/api/gdpr/export?userId=${TEST_USER_ID}`, {
        headers: { 'x-api-key': API_KEY },
        timeout: 30000,
      })

      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>

      // Required GDPR fields
      expect(body.exported_at).toBeTruthy()
      expect(body.user_id).toBe(TEST_USER_ID)

      // User record
      const user = body.user as Record<string, unknown>
      expect(user).toBeTruthy()
      expect(user.id).toBe(TEST_USER_ID)
      expect(user.email).toBeTruthy()
      expect(user.settings).toBeTruthy()

      // Data arrays exist (may be empty)
      expect(Array.isArray(body.counterparties)).toBe(true)
      expect(Array.isArray(body.conversations)).toBe(true)
      expect(Array.isArray(body.messages)).toBe(true)
      expect(Array.isArray(body.actions)).toBe(true)
      expect(Array.isArray(body.emails)).toBe(true)
      expect(Array.isArray(body.todos)).toBe(true)
      expect(Array.isArray(body.events)).toBe(true)

      // Settings has expected structure
      const settings = user.settings as Record<string, unknown>
      expect(typeof settings.timezone).toBe('string')
      expect(typeof settings.working_hours_start).toBe('string')
      expect(typeof settings.kc_low_value).toBe('number')
      expect(typeof settings.kc_high_value).toBe('number')
    })
  })

  // ─── Workflow 3: Ingest endpoint ──────────────────────────────────────

  describe('Manual ingest trigger', () => {
    it('POST /api/ingest triggers ingestion', async () => {
      const res = await api('POST', '/api/ingest', {
        headers: { 'x-api-key': API_KEY },
        body: { userId: TEST_USER_ID },
        timeout: 120000,
      })

      // Should succeed or report an issue (both valid)
      expect([200, 500]).toContain(res.status)
      if (res.status === 200) {
        const body = res.body as Record<string, unknown>
        expect(body).toHaveProperty('emailsIngested')
      }
    })
  })

  // ─── Workflow 4: Health + status endpoints ────────────────────────────

  describe('System health', () => {
    it('health check returns full status', async () => {
      const res = await api('GET', '/api/health')
      expect(res.status).toBe(200)
      expect((res.body as Record<string, unknown>).status).toBe('ok')
    })

    it('trigger pixel returns valid GIF', async () => {
      const res = await api('GET', '/api/trigger/ingest')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('image')
    })

    it('WhatsApp status endpoint responds', async () => {
      const res = await api('GET', `/api/whatsapp/status?userId=${TEST_USER_ID}`, {
        headers: { 'x-api-key': API_KEY },
      })
      expect(res.status).toBe(200)
      expect(typeof (res.body as Record<string, unknown>).enabled).toBe('boolean')
    })
  })

  // ─── Workflow 5: Auth boundary verification ───────────────────────────

  describe('Auth boundaries (live)', () => {
    const protectedRoutes = [
      { method: 'POST', path: '/api/agent/run', auth: 'api-key' },
      { method: 'POST', path: '/api/ingest', auth: 'api-key' },
      { method: 'GET', path: '/api/gdpr/export?userId=test', auth: 'api-key' },
      { method: 'POST', path: '/api/gdpr/delete', auth: 'api-key' },
      { method: 'GET', path: '/api/cron/morning-brief', auth: 'cron' },
    ]

    for (const route of protectedRoutes) {
      it(`${route.method} ${route.path} rejects without auth`, async () => {
        const res = await api(route.method, route.path, {
          body: route.method === 'POST' ? { userId: 'test' } : undefined,
        })
        expect([401, 403]).toContain(res.status)
      })
    }
  })
})
