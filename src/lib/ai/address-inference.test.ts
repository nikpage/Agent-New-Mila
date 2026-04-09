/**
 * Pinning tests: Address inference rules in AI prompts and planning code
 *
 * RULE: suggestedLocation is the MEETING VENUE, not the property/deal subject.
 * Email signature addresses are the sender's company address, not the venue.
 * Address selection is now deterministic in planning.ts (selectMeetingLocation),
 * and generateFinalDraft prompts still enforce venue rules for drafts.
 *
 * DO NOT modify expected values — if these fail, the address logic has regressed.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../..')

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf-8')
}

describe('Address inference — planning.ts (selectMeetingLocation + computeUrgencyFromEnrichment)', () => {
  const code = readSrc('src/services/planning.ts')

  it('suggestedLocation is defined as meeting venue, not property', () => {
    expect(code).toContain('WHERE PEOPLE WILL MEET')
    expect(code).toContain('NOT the property or deal subject')
  })

  it('has priority order for address inference', () => {
    expect(code).toContain('explicit venue')
    expect(code).toContain("CP's office")
    expect(code).toContain("user's office")
    expect(code).toContain('property address ONLY if the meeting is literally at the property')
  })

  it('warns about email signature addresses', () => {
    expect(code).toContain('signature')
    expect(code).toContain("SENDER's company address")
  })

  it('has the Karlin anti-example', () => {
    // This specific anti-example prevents confusing deal subject with venue
    expect(code).toContain('office space in Karlin')
    expect(code).toContain('does NOT mean the meeting is in Karlin')
  })

  it('ADDRESS INFERENCE rule exists in the planning module', () => {
    expect(code).toContain('ADDRESS INFERENCE for SCHEDULE')
    expect(code).toContain('MEETING VENUE')
  })
})

describe('Address inference — mila-voice.ts (generateFinalDraft prompt)', () => {
  const code = readSrc('src/lib/ai/mila-voice.ts')

  it('warns about email signature addresses in draft generation', () => {
    expect(code).toContain('signature')
    expect(code).toContain("SENDER's company address")
  })
})
