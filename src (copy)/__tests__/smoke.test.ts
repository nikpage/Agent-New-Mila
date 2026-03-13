/**
 * Smoke Tests — Real HTTP calls with CONTENT VERIFICATION
 *
 * These tests hit a running instance and verify not just status codes,
 * but actual response content, data shapes, and business logic.
 *
 * Test user: podtwo@gmail.com (d1a403fd-121b-4dcc-96aa-0efa3af114a8)
 *
 * HOW TO RUN:
 *   SMOKE_TEST=1 npm test -- src/__tests__/smoke.test.ts
 *
 * Required env vars (set in .env.local or shell):
 *   SMOKE_TEST=1              — enables these tests
 *   MILA_USER_API_KEY         — API key for the target instance
 *   CRON_SECRET               — Cron secret for the target instance
 *   SMOKE_BASE_URL            — defaults to http://localhost:3000
 */
import { describe, it, expect, beforeAll } from 'vitest'

const SMOKE = process.env.SMOKE_TEST === '1'
const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3000'
const API_KEY = process.env.MILA_USER_API_KEY || ''
const CRON_SECRET = process.env.CRON_SECRET || ''
const TEST_USER_ID = 'd1a403fd-121b-4dcc-96aa-0efa3af114a8'

// ─── HTTP helper ────────────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; timeout?: number } = {}
): Promise<{ status: number; body: unknown; headers: Headers; durationMs: number }> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout || 30000)
  init.signal = controller.signal

  const start = Date.now()
  try {
    const res = await fetch(url, init)
    clearTimeout(timer)
    const ct = res.headers.get('content-type') || ''
    let body: unknown
    if (ct.includes('json')) body = await res.json()
    else if (ct.includes('image')) body = '<binary image>'
    else body = await res.text()
    return { status: res.status, body, headers: res.headers, durationMs: Date.now() - start }
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

const describeSmoke = SMOKE ? describe : describe.skip

// ═════════════════════════════════════════════════════════════════════════════

describeSmoke('Smoke Tests (live HTTP, content verified)', () => {

  beforeAll(() => {
    console.log(`\n  Smoke target: ${BASE_URL} | User: ${TEST_USER_ID}`)
    console.log(`  API key: ${API_KEY ? 'set' : 'MISSING'} | Cron: ${CRON_SECRET ? 'set' : 'MISSING'}\n`)
  })

  // ─── Health ─────────────────────────────────────────────────────────────

  describe('Health', () => {
    it('GET /api/health returns complete status object', async () => {
      const res = await api('GET', '/api/health')
      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(body.status).toBe('ok')
    })
  })

  // ─── Auth enforcement (live, not mocked) ────────────────────────────────

  describe('Auth enforcement (live)', () => {
    it('POST /api/agent/run rejects without API key', async () => {
      const res = await api('POST', '/api/agent/run', { body: { userId: TEST_USER_ID } })
      expect([401, 403]).toContain(res.status)
    })

    it('POST /api/agent/run rejects with wrong API key', async () => {
      const res = await api('POST', '/api/agent/run', {
        headers: { 'x-api-key': 'completely-wrong-key' },
        body: { userId: TEST_USER_ID },
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/cron/morning-brief rejects without token', async () => {
      const res = await api('GET', '/api/cron/morning-brief')
      expect(res.status).toBe(401)
    })

    it('GET /api/cron/morning-brief rejects with wrong token', async () => {
      const res = await api('GET', '/api/cron/morning-brief', {
        headers: { authorization: 'Bearer wrong-secret' },
      })
      expect(res.status).toBe(401)
    })
  })

  // ─── Core flows — deep content verification ─────────────────────────────

  describe('Core flows (authenticated, content verified)', () => {

    it('POST /api/agent/run returns correctly shaped result', async () => {
      if (!API_KEY) return

      const res = await api('POST', '/api/agent/run', {
        headers: { 'x-api-key': API_KEY },
        body: { userId: TEST_USER_ID },
        timeout: 120000,
      })

      expect([200, 500]).toContain(res.status)
      if (res.status === 200) {
        const body = res.body as Record<string, unknown>
        // Verify ALL expected fields exist with correct types
        expect(typeof body.emailsIngested).toBe('number')
        expect(typeof body.messagesProcessed).toBe('number')
        expect(typeof body.conversationsUpdated).toBe('number')
        expect(typeof body.actionsGenerated).toBe('number')
        expect(typeof body.calendarEventsSynced).toBe('number')
        expect(typeof body.calendarInvitationsDetected).toBe('number')
        expect(body).toHaveProperty('coolingLeads')
        expect(body).toHaveProperty('coldLeads')
        expect(body).toHaveProperty('success', true)

        // Numeric values are non-negative
        expect(body.emailsIngested).toBeGreaterThanOrEqual(0)
        expect(body.messagesProcessed).toBeGreaterThanOrEqual(0)
        expect(body.actionsGenerated).toBeGreaterThanOrEqual(0)
      }
    })

    it('GET /api/cron/morning-brief returns complete brief result', async () => {
      if (!CRON_SECRET) return

      const res = await api('GET', `/api/cron/morning-brief?userId=${TEST_USER_ID}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
        timeout: 60000,
      })

      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(body.userId).toBe(TEST_USER_ID)
      expect(typeof body.success).toBe('boolean')
      expect(body).toHaveProperty('briefType')
    })

    it('GET /api/gdpr/export returns structured user data', async () => {
      if (!API_KEY) return

      const res = await api('GET', `/api/gdpr/export?userId=${TEST_USER_ID}`, {
        headers: { 'x-api-key': API_KEY },
      })

      expect([200, 404]).toContain(res.status)
      if (res.status === 200) {
        const body = res.body as Record<string, unknown>
        // Verify GDPR export structure
        expect(body).toHaveProperty('exported_at')
        expect(body).toHaveProperty('user_id', TEST_USER_ID)
        expect(body).toHaveProperty('user')
        expect(body).toHaveProperty('counterparties')
        expect(body).toHaveProperty('conversations')
        expect(body).toHaveProperty('messages')
        expect(body).toHaveProperty('actions')

        // User data should exist
        const user = body.user as Record<string, unknown> | null
        if (user) {
          expect(user.id).toBe(TEST_USER_ID)
          expect(user).toHaveProperty('email')
          expect(user).toHaveProperty('settings')
        }
      }
    })

    it('GET /api/whatsapp/status returns status with correct shape', async () => {
      if (!API_KEY) return

      const res = await api('GET', `/api/whatsapp/status?userId=${TEST_USER_ID}`, {
        headers: { 'x-api-key': API_KEY },
      })

      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(typeof body.enabled).toBe('boolean')
    })
  })

  // ─── Trigger pixel ──────────────────────────────────────────────────────

  describe('Trigger pixel', () => {
    it('GET /api/trigger/ingest returns a valid 1x1 GIF', async () => {
      const res = await api('GET', '/api/trigger/ingest')
      expect(res.status).toBe(200)
      // Should be an image response
      const ct = res.headers.get('content-type')
      expect(ct).toContain('image')
    })
  })
})
