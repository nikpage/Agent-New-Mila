/**
 * Mila Command Parser
 * Detects and classifies self-email commands with "Mila:" subject prefix.
 */

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
 * Strips the "Mila:" prefix, matches against known command keywords.
 * Throws CommandParseError for unknown commands or empty body.
 */
export function classifyCommand(subject: string, body: string): MilaCommandEmail {
  const stripped = subject.trim().replace(MILA_PREFIX, '').trim().toLowerCase()

  // Find matching command type
  let matchedType: MilaCommandType | undefined

  // Try exact match first, then prefix match for longer subjects
  // e.g. "Mila: todo call the notary" → stripped = "todo call the notary"
  for (const [alias, type] of Object.entries(COMMAND_ALIASES)) {
    if (stripped === alias || stripped.startsWith(alias + ' ')) {
      matchedType = type
      break
    }
  }

  if (!matchedType) {
    throw new CommandParseError(
      `Neznámý příkaz: "${stripped}". Podporované příkazy: new contact, todo`
    )
  }

  const trimmedBody = (body || '').trim()
  if (!trimmedBody) {
    throw new CommandParseError(
      `Příkaz "${stripped}" vyžaduje obsah v těle emailu`
    )
  }

  return {
    type: matchedType,
    subject: subject.trim(),
    body: trimmedBody,
  }
}
