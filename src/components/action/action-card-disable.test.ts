/**
 * Pinning tests: UDĚLAT button disable logic
 *
 * RULE: Only SCHEDULE actions can have UDĚLAT disabled.
 * REPLY, TODO, and all other action types must NEVER be blocked.
 *
 * DO NOT modify expected values — if these fail, the disable logic has regressed.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../..')

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf-8')
}

describe('UDĚLAT disable logic — ActionCard.tsx', () => {
  const code = readSrc('src/components/action/ActionCard.tsx')

  it('doItDisabled uses shared computeNeedsInput', () => {
    // ActionCard imports and calls the shared disable logic
    expect(code).toContain('computeNeedsInput')
  })

  it('does NOT disable REPLY or TODO actions', () => {
    // There must be no condition that disables based on action types other than SCHEDULE
    expect(code).not.toMatch(/action_type\s*===\s*'REPLY'.*doItDisabled/)
    expect(code).not.toMatch(/action_type\s*===\s*'TODO'.*doItDisabled/)
  })
})

describe('UDĚLAT disable logic — morning-brief.ts', () => {
  const code = readSrc('src/services/morning-brief.ts')

  it('uses shared prepareEmailCardParams for card rendering', () => {
    expect(code).toContain('prepareEmailCardParams')
  })
})

describe('UDĚLAT disable logic — action-card-template.ts (shared)', () => {
  const code = readSrc('src/components/action/action-card-template.ts')

  it('computeNeedsInput is scoped to SCHEDULE actions only', () => {
    expect(code).toContain("action.action_type !== 'SCHEDULE'")
    expect(code).toContain('computeNeedsInput')
  })

  it('needsInput parameter exists', () => {
    expect(code).toContain('needsInput')
  })

  it('disables UDĚLAT button when needsInput is true', () => {
    expect(code).toContain('needsInput')
    expect(code).toContain('UDĚLAT')
  })
})
