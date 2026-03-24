import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('@/lib/ai/runner', () => ({
  runAITask: vi.fn(),
}))

vi.mock('@/lib/db/counterparties', () => ({
  findOrCreateCP: vi.fn(),
  upsertCP: vi.fn(),
  updateCP: vi.fn(),
}))

vi.mock('@/lib/db/todos', () => ({
  createTodo: vi.fn(),
}))

vi.mock('@/lib/whatsapp/types', () => ({
  normalizePhoneNumber: vi.fn((p: string) => '+' + p.replace(/[^\d]/g, '')),
}))

import { executeCommand } from './executor'
import { runAITask } from '@/lib/ai/runner'
import { findOrCreateCP, upsertCP, updateCP } from '@/lib/db/counterparties'
import { createTodo } from '@/lib/db/todos'
import type { MilaCommandEmail } from './parser'

const mockRunAITask = vi.mocked(runAITask)
const mockFindOrCreateCP = vi.mocked(findOrCreateCP)
const mockUpsertCP = vi.mocked(upsertCP)
const mockUpdateCP = vi.mocked(updateCP)
const mockCreateTodo = vi.mocked(createTodo)

const userId = 'test-user-id'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('executeCommand — new_contact', () => {
  const cmd: MilaCommandEmail = {
    type: 'new_contact',
    subject: 'Mila: new contact',
    body: 'Jan Novotný, jan@novotny.cz, +420777123456, buyer',
  }

  it('creates a CP with email via findOrCreateCP', async () => {
    mockRunAITask.mockResolvedValue(JSON.stringify({
      name: 'Jan Novotný',
      email: 'jan@novotny.cz',
      phone: '+420777123456',
      role: 'buyer',
    }))
    mockFindOrCreateCP.mockResolvedValue({
      id: 'cp-1', user_id: userId, primary_identifier: 'jan@novotny.cz',
      name: 'Jan Novotný', role: null, is_blacklisted: false,
      other_identifiers: null, locations: null, created_at: new Date().toISOString(),
    } as any)
    mockUpdateCP.mockResolvedValue({} as any)

    const result = await executeCommand(cmd, userId)

    expect(result.success).toBe(true)
    expect(result.commandType).toBe('new_contact')
    expect(result.summary).toContain('Jan Novotný')
    expect(mockFindOrCreateCP).toHaveBeenCalledWith(userId, 'jan@novotny.cz', 'Jan Novotný')
    expect(mockUpdateCP).toHaveBeenCalledWith('cp-1', expect.objectContaining({
      other_identifiers: expect.objectContaining({ phones: expect.any(Array) }),
    }))
    expect(mockUpdateCP).toHaveBeenCalledWith('cp-1', expect.objectContaining({
      role: 'buyer',
    }))
  })

  it('creates CP with synthetic identifier when no email', async () => {
    mockRunAITask.mockResolvedValue(JSON.stringify({
      name: 'Jan Novotný',
    }))
    mockUpsertCP.mockResolvedValue({
      id: 'cp-2', user_id: userId, primary_identifier: 'manual:jan-novotny',
      name: 'Jan Novotný', role: null, is_blacklisted: false,
      other_identifiers: null, locations: null, created_at: new Date().toISOString(),
    } as any)

    const result = await executeCommand(cmd, userId)

    expect(result.success).toBe(true)
    expect(mockUpsertCP).toHaveBeenCalledWith(expect.objectContaining({
      user_id: userId,
      primary_identifier: expect.stringContaining('manual:'),
      name: 'Jan Novotný',
    }))
  })

  it('returns failure when AI cannot extract a name', async () => {
    mockRunAITask.mockResolvedValue(JSON.stringify({ error: 'no_name_found' }))

    const result = await executeCommand(cmd, userId)

    expect(result.success).toBe(false)
    expect(result.error).toBe('no_name_found')
  })

  it('returns failure on AI parse error (invalid JSON)', async () => {
    mockRunAITask.mockResolvedValue('not valid json at all')

    const result = await executeCommand(cmd, userId)

    expect(result.success).toBe(false)
    expect(result.error).toBe('ai_parse_failed')
  })
})

describe('executeCommand — todo', () => {
  const cmd: MilaCommandEmail = {
    type: 'todo',
    subject: 'Mila: todo',
    body: 'Call the notary about Květinová deal by Friday',
  }

  it('creates a todo with description and due date', async () => {
    mockRunAITask.mockResolvedValue(JSON.stringify({
      description: 'Call the notary about Květinová deal',
      dueDate: '2026-03-27',
    }))
    mockCreateTodo.mockResolvedValue({
      id: 'todo-1', user_id: userId,
      description: 'Call the notary about Květinová deal',
      due_date: '2026-03-27', status: 'pending', created_at: new Date().toISOString(),
    } as any)

    const result = await executeCommand(cmd, userId)

    expect(result.success).toBe(true)
    expect(result.commandType).toBe('todo')
    expect(result.summary).toContain('Call the notary')
    expect(result.summary).toContain('2026-03-27')
    expect(mockCreateTodo).toHaveBeenCalledWith(expect.objectContaining({
      user_id: userId,
      description: 'Call the notary about Květinová deal',
      due_date: '2026-03-27',
      status: 'pending',
    }))
  })

  it('falls back to raw body when AI returns invalid JSON', async () => {
    mockRunAITask.mockResolvedValue('garbage output')
    mockCreateTodo.mockResolvedValue({
      id: 'todo-2', user_id: userId,
      description: cmd.body, due_date: null, status: 'pending',
      created_at: new Date().toISOString(),
    } as any)

    const result = await executeCommand(cmd, userId)

    expect(result.success).toBe(true)
    expect(mockCreateTodo).toHaveBeenCalledWith(expect.objectContaining({
      description: cmd.body,
      due_date: null,
    }))
  })

  it('creates todo without due date when none specified', async () => {
    mockRunAITask.mockResolvedValue(JSON.stringify({
      description: 'Buy flowers',
    }))
    mockCreateTodo.mockResolvedValue({
      id: 'todo-3', user_id: userId,
      description: 'Buy flowers', due_date: null, status: 'pending',
      created_at: new Date().toISOString(),
    } as any)

    const result = await executeCommand(cmd, userId)

    expect(result.success).toBe(true)
    expect(mockCreateTodo).toHaveBeenCalledWith(expect.objectContaining({
      due_date: null,
    }))
  })
})
