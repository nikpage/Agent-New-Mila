import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all external dependencies
vi.mock('./ingestion', () => ({
  ingestEmailsForUser: vi.fn().mockResolvedValue([]),
  ingestOutboundEmails: vi.fn().mockResolvedValue(0),
}))

vi.mock('./threading', () => ({
  processMessagesForThreading: vi.fn().mockResolvedValue(new Map()),
}))

vi.mock('./planning', () => ({
  generateActionsForConversations: vi.fn().mockResolvedValue([]),
}))

vi.mock('./calendar-ingestion', () => ({
  ingestCalendarEvents: vi.fn().mockResolvedValue({
    eventsSynced: 0,
    invitationsDetected: 0,
    actionsCreated: 0,
    errors: [],
  }),
}))

vi.mock('./lead-tracking', () => ({
  trackLeadsForUser: vi.fn().mockResolvedValue({
    conversationsScanned: 0,
    coolingLeads: 0,
    coldLeads: 0,
    deadLeads: 0,
    followUpsCreated: 0,
    errors: [],
  }),
}))

vi.mock('@/lib/db/messages', () => ({
  getUnprocessedMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/users', () => ({
  getUserById: vi.fn().mockResolvedValue({
    id: 'user-1',
    email: 'test@test.com',
    google_oauth_tokens: { access_token: 'token' },
  }),
}))

vi.mock('@/lib/db/counterparties', () => ({
  purgeUserAsCp: vi.fn().mockResolvedValue(0),
}))

import { runAgentForUser } from './agent'
import { ingestEmailsForUser, ingestOutboundEmails } from './ingestion'
import { ingestCalendarEvents } from './calendar-ingestion'
import { trackLeadsForUser } from './lead-tracking'
import { getUserById } from '@/lib/db/users'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getUserById).mockResolvedValue({
    id: 'user-1',
    email: 'test@test.com',
    google_oauth_tokens: { access_token: 'token' },
  } as unknown as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)
})

// Use unique user IDs per test to avoid in-memory guard conflicts
let testCounter = 0
function uniqueUserId() { return `user-test-${++testCounter}` }

describe('runAgentForUser', () => {
  it('returns success on a clean run', async () => {
    const result = await runAgentForUser(uniqueUserId())

    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('skips concurrent run for same user (in-memory guard)', async () => {
    const uid = uniqueUserId()
    let resolveIngestion!: () => void

    // Make ingestion block until we release it — use mockImplementationOnce so it doesn't leak
    vi.mocked(ingestEmailsForUser).mockImplementationOnce(
      () => new Promise(resolve => { resolveIngestion = () => resolve([] as never) })
    )

    const first = runAgentForUser(uid)
    // Yield so first call reaches past runningUsers.set() and into await getUserById
    await new Promise(r => setTimeout(r, 10))

    const second = await runAgentForUser(uid)

    expect(second.success).toBe(true)
    expect(second.errors).toContain('Skipped — concurrent run already in progress')

    // Let first finish
    resolveIngestion()
    await first
  })

  it('releases in-memory guard after completion', async () => {
    const uid = uniqueUserId()
    await runAgentForUser(uid)

    // Second call should NOT be skipped
    const result = await runAgentForUser(uid)

    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('releases in-memory guard even on failure', async () => {
    const uid = uniqueUserId()
    vi.mocked(getUserById).mockRejectedValueOnce(new Error('DB exploded'))

    const failResult = await runAgentForUser(uid)
    expect(failResult.success).toBe(false)

    // Guard should be released — next run proceeds
    vi.mocked(getUserById).mockResolvedValueOnce({
      id: uid,
      email: 'test@test.com',
      google_oauth_tokens: { access_token: 'token' },
    } as unknown as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)
    const okResult = await runAgentForUser(uid)
    expect(okResult.success).toBe(true)
  })

  it('returns error when user not found', async () => {
    vi.mocked(getUserById).mockResolvedValueOnce(null as never)

    const result = await runAgentForUser(uniqueUserId())

    expect(result.success).toBe(false)
    expect(result.errors).toContain('User not found')
  })

  it('returns error when user has no credentials', async () => {
    vi.mocked(getUserById).mockResolvedValueOnce({
      id: 'user-1',
      email: 'test@test.com',
      google_oauth_tokens: null,
    } as never)

    const result = await runAgentForUser(uniqueUserId())

    expect(result.success).toBe(false)
    expect(result.errors).toContain('User has no Google credentials')
  })

  describe('fault isolation (Promise.allSettled)', () => {
    it('continues when email ingestion fails', async () => {
      vi.mocked(ingestEmailsForUser).mockRejectedValue(new Error('Gmail API down'))
      vi.mocked(ingestOutboundEmails).mockResolvedValue(3)

      const result = await runAgentForUser(uniqueUserId())

      expect(result.success).toBe(true)
      expect(result.emailsIngested).toBe(3) // outbound still counted
      expect(result.errors.some(e => e.includes('Email ingestion'))).toBe(true)
    })

    it('continues when outbound ingestion fails', async () => {
      vi.mocked(ingestOutboundEmails).mockRejectedValue(new Error('Token expired'))
      vi.mocked(ingestEmailsForUser).mockResolvedValue([{ id: '1' }] as never)

      const result = await runAgentForUser(uniqueUserId())

      expect(result.success).toBe(true)
      expect(result.emailsIngested).toBe(1) // inbound counted
      expect(result.errors.some(e => e.includes('Outbound ingestion'))).toBe(true)
    })

    it('continues when calendar sync fails', async () => {
      vi.mocked(ingestCalendarEvents).mockRejectedValue(new Error('Calendar scope missing'))

      const result = await runAgentForUser(uniqueUserId())

      expect(result.success).toBe(true)
      expect(result.errors.some(e => e.includes('Calendar ingestion'))).toBe(true)
    })

    it('all three ingestion steps can fail without crashing', async () => {
      vi.mocked(ingestEmailsForUser).mockRejectedValue(new Error('fail 1'))
      vi.mocked(ingestOutboundEmails).mockRejectedValue(new Error('fail 2'))
      vi.mocked(ingestCalendarEvents).mockRejectedValue(new Error('fail 3'))

      const result = await runAgentForUser(uniqueUserId())

      expect(result.success).toBe(true)
      expect(result.errors).toHaveLength(3)
    })

    it('continues when lead tracking fails', async () => {
      vi.mocked(trackLeadsForUser).mockRejectedValue(new Error('lead tracking crash'))

      const result = await runAgentForUser(uniqueUserId())

      expect(result.success).toBe(true)
      expect(result.errors.some(e => e.includes('Lead tracking'))).toBe(true)
    })
  })
})
