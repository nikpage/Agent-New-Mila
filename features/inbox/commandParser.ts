// features/inbox/commandParser.ts

export interface ParsedCommand {
  command: 'DO_IT' | 'EDIT' | 'ILL_DO_IT' | 'BLACKLIST_CP' | null;
  actionId: string | null;
  editNotes?: string;
}

/**
 * Extract action_id from any URL in email body
 * Looks for action_id=<uuid> in any context (URL, HTML src, plain text)
 */
export function extractActionId(emailBody: string): string | null {
  const actionIdPattern = /action_id=([a-f0-9-]{36})/i;
  const match = emailBody.match(actionIdPattern);
  return match ? match[1] : null;
}

/**
 * Parse the first line of email for commands (case-insensitive)
 * Supported commands: DO IT, EDIT:, I'LL DO IT, BLACKLIST CP
 * Trims and skips empty lines to handle email client headers
 */
export function parseCommand(emailBody: string): ParsedCommand['command'] | { command: 'EDIT'; notes: string } {
  // Skip empty lines and find first non-empty line
  const lines = emailBody.split('\n');
  let firstLine = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      firstLine = trimmed;
      break;
    }
  }

  if (!firstLine) {
    return null;
  }

  const upperLine = firstLine.toUpperCase();

  if (upperLine === 'DO IT') {
    return 'DO_IT';
  }

  if (upperLine.startsWith('EDIT:')) {
    const notes = firstLine.substring(5).trim();
    return { command: 'EDIT', notes };
  }

  if (upperLine === "I'LL DO IT") {
    return 'ILL_DO_IT';
  }

  if (upperLine === 'BLACKLIST CP') {
    return 'BLACKLIST_CP';
  }

  return null;
}

/**
 * Main parser: extracts both action_id and command from email body
 */
export function parseEmailCommand(emailBody: string): ParsedCommand {
  const actionId = extractActionId(emailBody);
  const commandResult = parseCommand(emailBody);

  if (!commandResult) {
    return { command: null, actionId };
  }

  if (typeof commandResult === 'object' && 'notes' in commandResult) {
    return {
      command: 'EDIT',
      actionId,
      editNotes: commandResult.notes,
    };
  }

  return {
    command: commandResult,
    actionId,
  };
}
