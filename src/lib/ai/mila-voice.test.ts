/**
 * Tests for mila-voice.ts — verifies the module exists, exports the right
 * functions, and that the old hardcoded text has been removed from callers.
 *
 * No mocks needed — these are structural/content verification tests.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../..')

// ─── Helper: read file as string ────────────────────────────────────────────
function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(SRC, relativePath), 'utf-8')
}

// ─── 1. mila-voice.ts exists and exports documented functions ───────────────
describe('mila-voice.ts module', () => {
  it('file exists', () => {
    const filePath = path.join(SRC, 'src/lib/ai/mila-voice.ts')
    expect(fs.existsSync(filePath), 'src/lib/ai/mila-voice.ts must exist').toBe(true)
  })

  it('exports generateSchedulingIntent', async () => {
    const mod = await import('@/lib/ai/mila-voice')
    expect(typeof mod.generateSchedulingIntent).toBe('function')
  })

  it('exports generateLeadFollowUpIntent', async () => {
    const mod = await import('@/lib/ai/mila-voice')
    expect(typeof mod.generateLeadFollowUpIntent).toBe('function')
  })

  it('exports generateBriefIntro', async () => {
    const mod = await import('@/lib/ai/mila-voice')
    expect(typeof mod.generateBriefIntro).toBe('function')
  })

  it('exports generateUrgentIntro', async () => {
    const mod = await import('@/lib/ai/mila-voice')
    expect(typeof mod.generateUrgentIntro).toBe('function')
  })

  it('exports generateFinalDraft', async () => {
    const mod = await import('@/lib/ai/mila-voice')
    expect(typeof mod.generateFinalDraft).toBe('function')
  })
})

// ─── 2. planning.ts: no hardcoded Czech intent overwrites ───────────────────
describe('planning.ts — no hardcoded intent overwrites', () => {
  const code = readSrc('src/services/planning.ts')

  it('does not overwrite proposal.intent_cs with hardcoded string', () => {
    // The old pattern: proposal.intent_cs = `Schůzka s ...`
    // or proposal.intent_cs = `Zablokovala jsem ...`
    // or proposal.intent_cs = `Navrhla jsem ...`
    const assignmentPattern = /proposal\.intent_cs\s*=\s*`/
    expect(
      assignmentPattern.test(code),
      'planning.ts must not assign hardcoded template strings to proposal.intent_cs'
    ).toBe(false)
  })

  it('does not overwrite proposal.missingInfo with empty array', () => {
    // The old pattern: proposal.missingInfo = []
    const wipePattern = /proposal\.missingInfo\s*=\s*\[\]/
    expect(
      wipePattern.test(code),
      'planning.ts must not wipe proposal.missingInfo with []'
    ).toBe(false)
  })

  it('does not contain hardcoded "Schůzka s" intent template', () => {
    expect(code).not.toContain('Schůzka s ${cpName} je požadována')
  })

  it('does not contain hardcoded "Zablokovala jsem" intent template', () => {
    expect(code).not.toContain('Zablokovala jsem požadovaný termín')
  })

  it('does not contain hardcoded "Navrhla jsem optimální" intent template', () => {
    expect(code).not.toContain('Navrhla jsem optimální termín')
  })

  it('does not contain hardcoded "Klikněte na UDĚLAT" CTA', () => {
    expect(code).not.toContain('Klikněte na UDĚLAT')
  })

  it('does not contain hardcoded "Doplňte místo schůzky" CTA', () => {
    expect(code).not.toContain('Doplňte místo schůzky přes UPRAVIT')
  })

  it('does not contain hardcoded missingInfo label "Kde se má schůzka konat"', () => {
    expect(code).not.toContain('Kde se má schůzka konat?')
  })

  it('does not contain hardcoded missingInfo label "Upřesněte místo schůzky"', () => {
    expect(code).not.toContain('Upřesněte místo schůzky')
  })

  it('does not contain hardcoded missingInfo label "V nejbližších 14 dnech"', () => {
    expect(code).not.toContain('V nejbližších 14 dnech nejsou volné termíny')
  })

  it('does not contain hardcoded missingInfo label "Kdy byste chtěl/a se sejít"', () => {
    expect(code).not.toContain('Kdy byste chtěl/a se sejít')
  })

  it('imports from mila-voice', () => {
    expect(code).toContain('mila-voice')
  })
})

// ─── 3. morning-brief.ts: no hardcoded greeting/subject/urgent text ─────────
describe('morning-brief.ts — no hardcoded user-facing text', () => {
  const code = readSrc('src/services/morning-brief.ts')

  it('does not contain hardcoded greeting "Dobré ráno"', () => {
    expect(code).not.toContain("'Dobré ráno'")
    expect(code).not.toContain('"Dobré ráno"')
  })

  it('does not contain hardcoded greeting "Dobré odpoledne"', () => {
    expect(code).not.toContain("'Dobré odpoledne'")
    expect(code).not.toContain('"Dobré odpoledne"')
  })

  it('does not contain hardcoded subject template "Mila: ${subjectCount}"', () => {
    expect(code).not.toContain('navrhovaná akce')
    expect(code).not.toContain('navrhované akce')
    expect(code).not.toContain('navrhovaných akcí')
  })

  it('does not contain hardcoded urgent subject "urgentní akce"', () => {
    expect(code).not.toContain('urgentní akce')
  })

  it('does not contain hardcoded urgent header "Urgentní akce"', () => {
    expect(code).not.toContain('Urgentní akce')
  })

  it('does not contain hardcoded urgent body "vysoce prioritní"', () => {
    expect(code).not.toContain('vysoce prioritní')
  })

  it('imports from mila-voice', () => {
    expect(code).toContain('mila-voice')
  })
})

// ─── 4. lead-tracking.ts: no hardcoded intent/rationale templates ───────────
describe('lead-tracking.ts — no hardcoded intent templates', () => {
  const code = readSrc('src/services/lead-tracking.ts')

  it('does not contain hardcoded dead lead intent "neodpověděl/a už"', () => {
    expect(code).not.toContain('neodpověděl/a už')
  })

  it('does not contain hardcoded cold lead intent "neodpověděl/a"', () => {
    // This pattern appears in the cold template: "${cpName} neodpověděl/a ${days} dní"
    expect(code).not.toContain('neodpověděl/a')
  })

  it('does not contain hardcoded cooling intent "ztrácí tempo"', () => {
    expect(code).not.toContain('ztrácí tempo')
  })

  it('does not contain hardcoded rationale "Lead je neaktivní"', () => {
    expect(code).not.toContain('Lead je neaktivní')
  })

  it('does not contain hardcoded rationale "Lead chladne"', () => {
    expect(code).not.toContain('Lead chladne')
  })

  it('does not contain hardcoded rationale "Mírné zpomalení"', () => {
    expect(code).not.toContain('Mírné zpomalení')
  })

  it('imports from mila-voice', () => {
    expect(code).toContain('mila-voice')
  })
})

// ─── 5. gemini.ts: generateFinalDraft moved out ─────────────────────────────
describe('tasks.ts — generateFinalDraft moved to mila-voice', () => {
  const code = readSrc('src/lib/ai/tasks.ts')

  it('does not export generateFinalDraft', () => {
    // Should not have "export async function generateFinalDraft" or "export function generateFinalDraft"
    const exportPattern = /export\s+(async\s+)?function\s+generateFinalDraft/
    expect(
      exportPattern.test(code),
      'generateFinalDraft should live in mila-voice.ts, not tasks.ts'
    ).toBe(false)
  })
})

// ─── 6. UserSettings has tone fields ────────────────────────────────────────
describe('UserSettings tone fields', () => {
  it('ai_tone_user exists with correct default', async () => {
    const { DEFAULT_USER_SETTINGS } = await import('@/lib/supabase/types')
    expect(DEFAULT_USER_SETTINGS.ai_tone_user).toBe('professional and concise')
  })

  it('ai_tone_cp exists with correct default', async () => {
    const { DEFAULT_USER_SETTINGS } = await import('@/lib/supabase/types')
    expect(DEFAULT_USER_SETTINGS.ai_tone_cp).toBe('polite and formal')
  })
})
