/**
 * Reconstruction critic (Chunk 5)
 *
 * Quality check on fact/belief extraction.
 * Ask: "What information in the original messages is NOT in this extraction?"
 * If gaps are found, the caller can re-run extractFactsAndBeliefs() with the
 * gaps injected into the prompt. Maximum 1 re-run.
 */

import { runAITask } from '@/lib/ai/runner'
import type { ExtractionOutput } from './fact-extractor'

export interface CritiqueResult {
  gaps: string[]       // each item is a specific piece of missed information
  is_complete: boolean // true when gaps.length === 0
}

/**
 * Critique an extraction by comparing it against the original message texts.
 *
 * @param originalMessages  Array of cleaned message strings (in order)
 * @param extraction        The ExtractionOutput to evaluate
 */
export async function critiqueExtraction(
  originalMessages: string[],
  extraction: ExtractionOutput
): Promise<CritiqueResult> {
  if (originalMessages.length === 0) {
    return { gaps: [], is_complete: true }
  }

  const messagesBlock = originalMessages
    .map((m, i) => `[${i}] ${m.slice(0, 1500)}`)
    .join('\n\n')

  const factsBlock = extraction.hard_facts.length > 0
    ? extraction.hard_facts.map(f => `  ${f.type}.${f.key} = "${f.value}" (confidence: ${f.confidence})`).join('\n')
    : '  (none)'

  const obsBlock = extraction.soft_observations.length > 0
    ? extraction.soft_observations.map(o => `  ${o.topic}: "${o.content}" (confidence: ${o.confidence})`).join('\n')
    : '  (none)'

  const prompt = `You are reviewing a fact extraction for completeness.

ORIGINAL MESSAGES:
${messagesBlock}

EXTRACTION PRODUCED:

Hard facts:
${factsBlock}

Soft observations:
${obsBlock}

TASK: Identify any significant information present in the original messages that is NOT captured in the extraction above.

Focus only on:
- Specific prices, addresses, or dates that were mentioned but not extracted
- Explicit commitments or deadlines that were missed
- Deal stage changes not captured
- Key requests or questions from the counterparty that are absent

Ignore:
- Minor phrasing differences
- Information already present under a different key
- Subjective signals that are genuinely ambiguous

Respond with ONLY valid JSON:
{
  "gaps": ["description of gap 1", "description of gap 2"],
  "is_complete": true | false
}

If nothing was missed, return: {"gaps": [], "is_complete": true}`

  let raw: string
  try {
    raw = await runAITask('reconstruction_critic', prompt)
  } catch (err) {
    console.error('[Critic] LLM call failed:', err)
    // Fail open — treat as complete so we don't block the pipeline
    return { gaps: [], is_complete: true }
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { gaps: [], is_complete: true }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return { gaps: [], is_complete: true }
  }

  const gaps = Array.isArray(parsed.gaps)
    ? (parsed.gaps as unknown[]).filter((g): g is string => typeof g === 'string')
    : []

  return {
    gaps,
    is_complete: gaps.length === 0,
  }
}
