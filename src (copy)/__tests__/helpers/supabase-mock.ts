/**
 * Supabase client mock for unit tests.
 *
 * Returns a chainable query builder that records calls and returns
 * configurable data. Use `mockTable()` to pre-populate table responses.
 */
import { vi } from 'vitest'

export interface MockQueryResult {
  data: unknown[] | unknown | null
  error: null | { message: string; code?: string }
  count?: number
}

type QueryBuilder = {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  in: ReturnType<typeof vi.fn>
  lt: ReturnType<typeof vi.fn>
  not: ReturnType<typeof vi.fn>
  order: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
}

/**
 * Create a mock Supabase client.
 *
 * `tableData` maps table names to their default select() result.
 * Override per-call using the returned `setResponse` helper.
 */
export function createMockSupabase(tableData: Record<string, unknown[]> = {}) {
  const responses = new Map<string, MockQueryResult>()

  function setResponse(table: string, result: MockQueryResult) {
    responses.set(table, result)
  }

  function getResponse(table: string): MockQueryResult {
    if (responses.has(table)) return responses.get(table)!
    const data = tableData[table] ?? []
    return { data, error: null }
  }

  /** Builds a chainable query builder that resolves to a configured response */
  function buildChain(table: string): QueryBuilder {
    const chain: QueryBuilder = {} as QueryBuilder

    // Every method returns the chain (for .eq().lt().select() etc.)
    // The chain itself is also a thenable so `await supabase.from(t).select()` works
    const methods = ['select', 'insert', 'update', 'delete', 'eq', 'in', 'lt', 'not', 'order', 'limit'] as const

    for (const method of methods) {
      chain[method] = vi.fn().mockReturnValue(chain)
    }

    // .single() resolves with the first item or null
    chain.single = vi.fn().mockImplementation(() => {
      const res = getResponse(table)
      const firstItem = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data
      return Promise.resolve({ data: firstItem, error: res.error })
    })

    // Make the chain itself resolve like a promise (for queries without .single())
    // We do this by giving it a .then property
    Object.defineProperty(chain, 'then', {
      value: (resolve: (val: MockQueryResult) => void) => {
        resolve(getResponse(table))
      },
      writable: true,
      configurable: true,
    })

    return chain
  }

  const client = {
    from: vi.fn((table: string) => buildChain(table)),
  }

  return { client, setResponse, getResponse }
}
