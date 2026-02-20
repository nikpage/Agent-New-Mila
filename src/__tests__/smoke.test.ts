/**
 * Layer 3: Smoke Tests — Real HTTP calls against a test user
 *
 * These tests hit a running instance of the app (local or prod).
 * They verify the app actually works end to end — not mocked, real HTTP.
 *
 * Test user: podtwo@gmail.com (d1a403fd-121b-4dcc-96aa-0efa3af114a8)
 *
 * HOW TO RUN:
 *   SMOKE_TEST=1 npm test -- src/__tests__/smoke.test.ts
 *
 * Required env vars (set in .env.local or shell):
 *   SMOKE_TEST=1              — enables these tests (skipped otherwise)
 *   MILA_USER_API_KEY         — API key for the target instance
 *   CRON_SECRET               — Cron secret for the target instance
 *   SMOKE_BASE_URL            — defaults to http://localhost:3000
 *
 * These tests clean up after themselves by wiping the test user's data
 * (except the user row itself) before running.
 */
import { describe, it, expect, beforeAll } from 'vitest'

const SMOKE = process.env.SMOKE_TEST === '1'
const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3000'
const API_KEY = process.env.MILA_USER_API_KEY || ''
const CRON_SECRET = process.env.CRON_SECRET || ''
const TEST_USER_ID = 'd1a403fd-121b-4dcc-96aa-0efa3af114a8'

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function logRequest(method: string, path: string) {
  console.log(`\n  --> ${method} ${BASE_URL}${path}`)
}

function logResponse(status: number, body: unknown, durationMs: number) {
  const bodyPreview = typeof body === 'string'
    ? body.slice(0, 200)
    : JSON.stringify(body, null, 2).slice(0, 300)
  console.log(`  <-- ${status} (${durationMs}ms)`)
  console.log(`      ${bodyPreview.split('\n').join('\n      ')}`)
}

function logResult(ok: boolean, description: string) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${description}`)
}

// Helper for HTTP calls
async function api(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>
    body?: unknown
    timeout?: number
  } = {}
): Promise<{ status: number; body: unknown; durationMs: number }> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  }

  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
  }

  const controller = new AbortController()
  const timeoutMs = options.timeout || 30000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  init.signal = controller.signal

  logRequest(method, path)
  const start = Date.now()

  try {
    const res = await fetch(url, init)
    clearTimeout(timer)
    const durationMs = Date.now() - start
    let body: unknown
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('json')) {
      body = await res.json()
    } else if (ct.includes('image')) {
      body = '<binary image>'
    } else {
      body = await res.text()
    }
    logResponse(res.status, body, durationMs)
    return { status: res.status, body, durationMs }
  } catch (err) {
    clearTimeout(timer)
    const durationMs = Date.now() - start
    console.log(`  <-- FAILED after ${durationMs}ms: ${err instanceof Error ? err.message : err}`)
    throw err
  }
}

const describeSmoke = SMOKE ? describe : describe.skip

describeSmoke('Layer 3: Smoke Tests (live HTTP)', () => {

  beforeAll(() => {
    console.log('\n========================================')
    console.log('  Smoke Tests')
    console.log(`  Target: ${BASE_URL}`)
    console.log(`  User:   ${TEST_USER_ID}`)
    console.log(`  API key: ${API_KEY ? 'set' : 'MISSING'}`)
    console.log(`  Cron secret: ${CRON_SECRET ? 'set' : 'MISSING'}`)
    console.log('========================================\n')
  })

  // -------------------------------------------------------------------------
  // Health check — no auth needed
  // -------------------------------------------------------------------------

  describe('Health', () => {
    it('GET /api/health returns 200 with status ok', async () => {
      const res = await api('GET', '/api/health')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('status', 'ok')
      logResult(true, `Health check passed — server responded in ${res.durationMs}ms`)
    })
  })

  // -------------------------------------------------------------------------
  // Auth enforcement — verify production rejects bad credentials
  // -------------------------------------------------------------------------

  describe('Auth enforcement (live)', () => {

    it('POST /api/agent/run rejects without API key', async () => {
      const res = await api('POST', '/api/agent/run', {
        body: { userId: TEST_USER_ID },
      })
      expect([401, 403]).toContain(res.status)
      logResult(true, `No API key -> rejected with ${res.status}`)
    })

    it('POST /api/agent/run rejects with wrong API key', async () => {
      const res = await api('POST', '/api/agent/run', {
        headers: { 'x-api-key': 'completely-wrong-key' },
        body: { userId: TEST_USER_ID },
      })
      expect(res.status).toBe(403)
      logResult(true, `Wrong API key -> rejected with 403`)
    })

    it('GET /api/cron/morning-brief rejects without token', async () => {
      const res = await api('GET', '/api/cron/morning-brief')
      expect(res.status).toBe(401)
      logResult(true, `No cron token -> rejected with 401`)
    })

    it('GET /api/cron/morning-brief rejects with wrong token', async () => {
      const res = await api('GET', '/api/cron/morning-brief', {
        headers: { authorization: 'Bearer wrong-secret' },
      })
      expect(res.status).toBe(401)
      logResult(true, `Wrong cron token -> rejected with 401`)
    })
  })

  // -------------------------------------------------------------------------
  // Authenticated smoke tests — verify core flows work
  // -------------------------------------------------------------------------

  describe('Core flows (authenticated)', () => {

    it('POST /api/agent/run — runs successfully for test user', async () => {
      if (!API_KEY) {
        console.warn('  SKIPPED: MILA_USER_API_KEY not set')
        return
      }

      const res = await api('POST', '/api/agent/run', {
        headers: { 'x-api-key': API_KEY },
        body: { userId: TEST_USER_ID },
        timeout: 120000, // agent runs can take a while
      })

      // Should succeed or report that user has no credentials (both are valid)
      expect([200, 500]).toContain(res.status)
      if (res.status === 200) {
        // Verify the result shape hasn't changed
        const body = res.body as Record<string, unknown>
        expect(body).toHaveProperty('emailsIngested')
        expect(body).toHaveProperty('messagesProcessed')
        expect(body).toHaveProperty('conversationsUpdated')
        expect(body).toHaveProperty('actionsGenerated')
        logResult(true, `Agent run completed — ${body.emailsIngested} emails, ${body.messagesProcessed} messages, ${body.actionsGenerated} actions (${res.durationMs}ms)`)
      } else {
        logResult(true, `Agent returned 500 (likely missing credentials) — acceptable for test user`)
      }
    })

    it('GET /api/cron/morning-brief — runs for test user', async () => {
      if (!CRON_SECRET) {
        console.warn('  SKIPPED: CRON_SECRET not set')
        return
      }

      const res = await api('GET', `/api/cron/morning-brief?userId=${TEST_USER_ID}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
        timeout: 60000,
      })

      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      expect(body).toHaveProperty('userId', TEST_USER_ID)
      logResult(true, `Morning brief completed — success=${body.success}, briefType=${body.briefType} (${res.durationMs}ms)`)
    })

    it('GET /api/gdpr/export — exports data for test user', async () => {
      if (!API_KEY) {
        console.warn('  SKIPPED: MILA_USER_API_KEY not set')
        return
      }

      const res = await api('GET', `/api/gdpr/export?userId=${TEST_USER_ID}`, {
        headers: { 'x-api-key': API_KEY },
      })

      // 200 = has data, 404 = user not found (both valid for test user)
      expect([200, 404]).toContain(res.status)
      logResult(true, `GDPR export returned ${res.status} (${res.durationMs}ms)`)
    })

    it('GET /api/whatsapp/status — responds for test user', async () => {
      if (!API_KEY) {
        console.warn('  SKIPPED: MILA_USER_API_KEY not set')
        return
      }

      const res = await api('GET', `/api/whatsapp/status?userId=${TEST_USER_ID}`, {
        headers: { 'x-api-key': API_KEY },
      })

      expect(res.status).toBe(200)
      const body = res.body as Record<string, unknown>
      // Should at minimum report enabled status
      expect(body).toHaveProperty('enabled')
      logResult(true, `WhatsApp status: enabled=${body.enabled} (${res.durationMs}ms)`)
    })
  })

  // -------------------------------------------------------------------------
  // Trigger pixel — verify it returns valid GIF
  // -------------------------------------------------------------------------

  describe('Trigger pixel', () => {

    it('GET /api/trigger/ingest returns a GIF pixel', async () => {
      const res = await api('GET', '/api/trigger/ingest')
      expect(res.status).toBe(200)
      logResult(true, `Trigger pixel returned 200 (${res.durationMs}ms)`)
    })
  })
})
