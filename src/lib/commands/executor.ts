/**
 * Mila Command Executor
 * Executes parsed self-email commands using AI-assisted body parsing.
 */

import { v4 as uuidv4 } from 'uuid'
import type { MilaCommandEmail, MilaCommandType } from './parser'
import type { UserSettings, Json } from '@/lib/supabase/types'
import { VALID_CP_ROLES } from '@/lib/supabase/types'
import type { CPRole } from '@/lib/supabase/types'
import { runAITask } from '@/lib/ai/runner'
import { findOrCreateCP, upsertCP, updateCP } from '@/lib/db/counterparties'
import { createTodo } from '@/lib/db/todos'
import { normalizePhoneNumber } from '@/lib/whatsapp/types'

export interface CommandResult {
  success: boolean
  commandType: MilaCommandType
  summary: string
  error?: string
}

// --- new_contact ---

interface ParsedContact {
  name: string
  email?: string
  phone?: string
  role?: string
  company?: string
}

function buildContactParsePrompt(body: string): string {
  return `Extract contact information from the following text. Return ONLY valid JSON, no markdown.

Text:
${body}

Return JSON with these fields (omit fields not found):
{
  "name": "Full name (REQUIRED)",
  "email": "Email address",
  "phone": "Phone number with country code",
  "role": "One of: seller, buyer, landlord, tenant, agent, developer, other",
  "company": "Company or organization name"
}

If you cannot find a name, return: {"error": "no_name_found"}`
}

async function executeNewContact(
  command: MilaCommandEmail,
  userId: string
): Promise<CommandResult> {
  // AI-parse the freeform body
  const raw = await runAITask('classify', buildContactParsePrompt(command.body))
  let parsed: ParsedContact
  try {
    const cleaned = raw.replace(/```json?\s*\n?/g, '').replace(/```\s*$/g, '').trim()
    const json = JSON.parse(cleaned)
    if (json.error || !json.name) {
      return {
        success: false,
        commandType: 'new_contact',
        summary: 'Nepodařilo se rozpoznat kontaktní údaje — chybí jméno',
        error: json.error || 'no_name_found',
      }
    }
    parsed = json as ParsedContact
  } catch {
    return {
      success: false,
      commandType: 'new_contact',
      summary: 'Nepodařilo se rozpoznat kontaktní údaje z emailu',
      error: 'ai_parse_failed',
    }
  }

  // Create or find the CP
  let cpId: string
  let isUpdate = false

  if (parsed.email) {
    const cp = await findOrCreateCP(userId, parsed.email, parsed.name)
    if (!cp) {
      return {
        success: false,
        commandType: 'new_contact',
        summary: `Nelze vytvořit kontakt s vlastním emailem: ${parsed.email}`,
        error: 'self_email',
      }
    }
    cpId = cp.id
    // If CP already existed (created_at is old), this is an update
    const ageMs = Date.now() - new Date(cp.created_at).getTime()
    isUpdate = ageMs > 5000 // older than 5 seconds = pre-existing
  } else {
    // No email — create with synthetic identifier
    const syntheticId = 'manual:' + parsed.name.toLowerCase().replace(/\s+/g, '-').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    const cp = await upsertCP({
      user_id: userId,
      primary_identifier: syntheticId,
      name: parsed.name,
    })
    cpId = cp.id
  }

  // Update phone if provided
  if (parsed.phone) {
    const normalized = normalizePhoneNumber(parsed.phone)
    await updateCP(cpId, {
      other_identifiers: { phones: [normalized] } as Json,
    })
  }

  // Update role if valid
  if (parsed.role) {
    const lowerRole = parsed.role.toLowerCase()
    if ((VALID_CP_ROLES as readonly string[]).includes(lowerRole)) {
      await updateCP(cpId, { role: lowerRole as CPRole })
    }
  }

  // Update company in locations JSONB
  if (parsed.company) {
    await updateCP(cpId, {
      locations: { company: parsed.company } as Json,
    })
  }

  // Build summary
  const parts = [parsed.name]
  if (parsed.email) parts.push(parsed.email)
  if (parsed.phone) parts.push(normalizePhoneNumber(parsed.phone))
  if (parsed.role) parts.push(parsed.role)

  return {
    success: true,
    commandType: 'new_contact',
    summary: `Kontakt ${isUpdate ? 'aktualizován' : 'vytvořen'}: ${parts.join(', ')}`,
  }
}

// --- todo ---

interface ParsedTodo {
  description: string
  dueDate?: string
}

function buildTodoParsePrompt(body: string): string {
  return `Extract a task description and optional due date from the following text. Return ONLY valid JSON, no markdown.

Text:
${body}

Today's date: ${new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' })}

Return JSON:
{
  "description": "Clear, concise task description (REQUIRED)",
  "dueDate": "ISO date YYYY-MM-DD if a deadline is mentioned, otherwise omit"
}

Interpret relative dates like "tomorrow", "Friday", "next week" relative to today.`
}

async function executeTodo(
  command: MilaCommandEmail,
  userId: string
): Promise<CommandResult> {
  const raw = await runAITask('classify', buildTodoParsePrompt(command.body))
  let parsed: ParsedTodo
  try {
    const cleaned = raw.replace(/```json?\s*\n?/g, '').replace(/```\s*$/g, '').trim()
    const json = JSON.parse(cleaned)
    if (!json.description) {
      return {
        success: false,
        commandType: 'todo',
        summary: 'Nepodařilo se rozpoznat popis úkolu',
        error: 'no_description',
      }
    }
    parsed = json as ParsedTodo
  } catch {
    // Fallback: use raw body as description
    parsed = { description: command.body }
  }

  const todo = await createTodo({
    id: uuidv4(),
    user_id: userId,
    description: parsed.description,
    due_date: parsed.dueDate || null,
    status: 'pending',
  })

  const duePart = parsed.dueDate ? ` (do: ${parsed.dueDate})` : ''
  return {
    success: true,
    commandType: 'todo',
    summary: `Úkol vytvořen: "${parsed.description}"${duePart}`,
  }
}

// --- Main dispatcher ---

export async function executeCommand(
  command: MilaCommandEmail,
  userId: string,
  settings?: UserSettings
): Promise<CommandResult> {
  switch (command.type) {
    case 'new_contact':
      return executeNewContact(command, userId)
    case 'todo':
      return executeTodo(command, userId)
    default: {
      const _exhaustive: never = command.type
      return {
        success: false,
        commandType: command.type,
        summary: `Neznámý typ příkazu: ${command.type}`,
        error: 'unknown_type',
      }
    }
  }
}
