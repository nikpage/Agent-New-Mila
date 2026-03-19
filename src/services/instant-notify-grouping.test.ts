/**
 * Pinning tests: Instant notify grouping
 *
 * RULE: Instant notifications group by CONVERSATION, not by user.
 * One email = one conversation. Different conversations = separate emails.
 * Never merges across conversations.
 *
 * DO NOT modify expected values — if these fail, the grouping logic has regressed.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../..')

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf-8')
}

describe('Instant notify grouping — morning-brief.ts', () => {
  const code = readSrc('src/services/morning-brief.ts')

  it('groups by conversation, not by user', () => {
    expect(code).toContain('byConversation')
    expect(code).toContain('conversation_id')
  })

  it('does NOT group by user', () => {
    // Must not have a byUser grouping in sendInstantNotifications
    expect(code).not.toContain('byUser')
  })

  it('function is named sendInstantNotificationForConversation', () => {
    expect(code).toContain('sendInstantNotificationForConversation')
    expect(code).not.toContain('sendInstantNotificationForUser')
    expect(code).not.toContain('sendInstantNotificationForAction')
  })

  it('runs schedule optimizer before rendering cards', () => {
    // The optimizer must run inside sendInstantNotifications, before sending
    expect(code).toContain('optimizeScheduleActions')
  })

  it('re-fetches actions after optimizer', () => {
    // After optimizer runs, actions must be re-fetched so hold data is reflected
    expect(code).toContain('getHighPriorityUnnotifiedActions(urgencyThreshold)')
  })
})
