/**
 * Mila Command Parser
 * Detects and classifies self-email commands with "Mila:" subject prefix.
 * Uses fast alias matching first, then AI classification as fallback.
 */

import { runAITask } from '@/lib/ai/runner'

export type MilaCommandType = 'new_contact' | 'todo'

export interface MilaCommandEmail {
  type: MilaCommandType
  subject: string
  body: string
}

export class CommandParseError extends Error {
  userMessage: string
  constructor(userMessage: string) {
    super(userMessage)
    this.name = 'CommandParseError'
    this.userMessage = userMessage
  }
}

const MILA_PREFIX = /^mila:\s*/i

const COMMAND_ALIASES: Record<string, MilaCommandType> = {
  'new contact': 'new_contact',
  'contact': 'new_contact',
  'kontakt': 'new_contact',
  'nový kontakt': 'new_contact',
  'novy kontakt': 'new_contact',
  'add contact': 'new_contact',
  'add cp': 'new_contact',
  'přidej kontakt': 'new_contact',
  'pridej kontakt': 'new_contact',
  'todo': 'todo',
  'task': 'todo',
  'úkol': 'todo',
  'ukol': 'todo',
}

/**
 * Check if an email subject starts with "Mila:" (case-insensitive).
 * Must be at the start — "Re: Mila: ..." does NOT match.
 */
export function isMilaCommand(subject: string): boolean {
  if (!subject) return false
  return MILA_PREFIX.test(subject.trim())
}

/**
 * Classify a Mila command email into its type.
 * Fast alias match first, then AI classification fallback.
 */
export async function classifyCommand(subject: string, body: string): Promise<MilaCommandEmail> {
  const stripped = subject.trim().replace(MILA_PREFIX, '').trim().toLowerCase()

  const trimmedBody = (body || '').trim()
  if (!trimmedBody) {
    throw new CommandParseError(
      `Příkaz "${stripped}" vyžaduje obsah v těle emailu`
    )
  }

  // Fast path: exact alias match
  let matchedType: MilaCommandType | undefined
  for (const [alias, type] of Object.entries(COMMAND_ALIASES)) {
    if (stripped === alias || stripped.startsWith(alias + ' ')) {
      matchedType = type
      break
    }
  }

  // Slow path: AI classification
  if (!matchedType) {
    matchedType = await classifyWithAI(stripped, trimmedBody)
  }

  if (!matchedType) {
    throw new CommandParseError(
      `Neznámý příkaz: "${stripped}"`
    )
  }

  return {
    type: matchedType,
    subject: subject.trim(),
    body: trimmedBody,
  }
}

async function classifyWithAI(command: string, body: string): Promise<MilaCommandType | undefined> {
  const prompt = `The user sent a command email to their AI assistant. Classify the intent.

Subject (after "Mila:" prefix): "${command}"
Body preview: "${body.slice(0, 200)}"

Available command types:
- new_contact: The user wants to create or add a new contact/counterparty/person
- todo: The user wants to create a task or reminder

Return ONLY one of: new_contact, todo
If the intent doesn't match either, return: unknown`

  try {
    const result = (await runAITask('classify', prompt)).trim().toLowerCase()
    if (result === 'new_contact' || result === 'todo') return result
    return undefined
  } catch {
    return undefined
  }
}
