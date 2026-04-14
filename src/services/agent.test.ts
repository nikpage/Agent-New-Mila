import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all external dependencies
vi.mock('./ingestion', () => ({
  ingestEmailsForUser: vi.fn().mockResolvedValue([]),
  ingestOutboundEmails: vi.fn().mockResolvedValue(0),
}))

vi.mock('./threading', () => ({
  processTimelineEntries: vi.fn().mockResolvedValue(new Map()),
  rebuildConversationSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./calendar-ingestion', () => ({
  ingestCalendarEvents: vi.fn().mockResolvedValue({
    eventsSynced: 0,
    invitationsDetected: 0,
    actionsCreated: 0,
    errors: [],
  }),
}))

vi.mock('./graph-walker', () => ({
  walkAllDeals: vi.fn().mockResolvedValue([]),
}))

vi.mock('./scoring-engine', () => ({
  scoreWalkerOutput: vi.fn().mockReturnValue([]),
}))

vi.mock('./card-generator', () => ({
  generateCards: vi.fn().mockResolvedValue([]),
  insertCardsAsActions: vi.fn().mockResolvedValue([]),
}))

vi.mock('./reflection', () => ({
  runReflection: vi.fn().mockResolvedValue({ observationsWritten: 0 }),
}))

vi.mock('@/lib/db/timeline', () => ({
  getUnassignedTimelineEntries: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/counterparties', () => ({
  purgeUserAsCp: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/db/journal', () => ({
  getActiveJournalEntries: vi.fn().mockResolvedValue([]),
  expireTemporalEntries: vi.fn().mockResolvedValue(0),
}))

vi.mock('@/lib/db/users', () => ({
  getUserById: vi.fn().mockResolvedValue({
    id: 'user-1',
    email: 'test@test.com',
    google_oauth_tokens: { access_token: 'token' },
  }),
  getUserSettings: vi.fn().mockResolvedValue({ ai_language: 'Czech', kc_high_value: 5_000_000 }),
  updateUserSettings: vi.fn().mockResolvedValue(undefined),
  updateUserHistoryId: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/db/conversations', () => ({
  getConversationsForUser: vi.fn().mockResolvedValue([]),
  getRecentMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/db/locks', () => ({
  tryAcquireUserLock: vi.fn().mockResolvedValue(true),
  releaseUserLock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseAdmin: vi.fn().mockReturnValue({
    from: () => ({ update: () => ({ in: () => ({ data: null, error: null }) }) }),
  }),
}))

import { runAgentForUser } from './agent'
import { ingestEmailsForUser, ingestOutboundEmails } from './ingestion'
import { ingestCalendarEvents } from './calendar-ingestion'
import { walkAllDeals } from './graph-walker'
import { getUserById } from '@/lib/db/users'
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getUserById).mockResolvedValue({
    id: 'user-1',
    email: 'test@test.com',
    google_oauth_tokens: { access_token: 'token' },
  } as unknown as ReturnType<typeof getUserById> extends Promise<infer T> ? T : never)
})

describe('runAgentForUser', () => {
  it('returns success on a clean run', async () => {
    const result = await runAgentForUser('user-1')

    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('returns error when user not found', async () => {
    vi.mocked(getUserById).mockResolvedValueOnce(null as never)

    const result = await runAgentForUser('user-1')

    expect(result.success).toBe(false)
    expect(result.errors).toContain('User not found')
  })

  it('returns error when user has no credentials', async () => {
    vi.mocked(getUserById).mockResolvedValueOnce({
      id: 'user-1',
      email: 'test@test.com',
      google_oauth_tokens: null,
    } as never)

    const result = await runAgentForUser('user-1')

    expect(result.success).toBe(false)
    expect(result.errors).toContain('User has no Google credentials')
  })

  describe('fault isolation (Promise.allSettled)', () => {
    it('continues when email ingestion fails', async () => {
      vi.mocked(ingestEmailsForUser).mockRejectedValue(new Error('Gmail API down'))
      vi.mocked(ingestOutboundEmails).mockResolvedValue(3)

      const result = await runAgentForUser('user-1')

      expect(result.success).toBe(true)
      expect(result.emailsIngested).toBe(3) // outbound still counted
      expect(result.errors.some(e => e.includes('Email ingestion'))).toBe(true)
    })

    it('continues when outbound ingestion fails', async () => {
      vi.mocked(ingestOutboundEmails).mockRejectedValue(new Error('Token expired'))
      vi.mocked(ingestEmailsForUser).mockResolvedValue([{ id: '1' }] as never)

      const result = await runAgentForUser('user-1')

      expect(result.success).toBe(true)
      expect(result.emailsIngested).toBe(1) // inbound counted
      expect(result.errors.some(e => e.includes('Outbound ingestion'))).toBe(true)
    })

    it('continues when calendar sync fails', async () => {
      vi.mocked(ingestCalendarEvents).mockRejectedValue(new Error('Calendar scope missing'))

      const result = await runAgentForUser('user-1')

      expect(result.success).toBe(true)
      expect(result.errors.some(e => e.includes('Calendar ingestion'))).toBe(true)
    })

    it('all three ingestion steps can fail without crashing', async () => {
      vi.mocked(ingestEmailsForUser).mockRejectedValue(new Error('fail 1'))
      vi.mocked(ingestOutboundEmails).mockRejectedValue(new Error('fail 2'))
      vi.mocked(ingestCalendarEvents).mockRejectedValue(new Error('fail 3'))

      const result = await runAgentForUser('user-1')

      expect(result.success).toBe(true)
      // 3 ingestion errors; planner is mocked to succeed so no 4th error
      expect(result.errors).toHaveLength(3)
    })

    it('continues when planner fails', async () => {
      vi.mocked(walkAllDeals).mockRejectedValue(new Error('graph walker crash'))

      const result = await runAgentForUser('user-1')

      expect(result.success).toBe(true)
      expect(result.errors.some(e => e.includes('Planner'))).toBe(true)
    })
  })
})
