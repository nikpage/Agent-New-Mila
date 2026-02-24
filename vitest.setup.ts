/**
 * Vitest Setup — Loads .env.local for integration tests
 *
 * Integration tests need SUPABASE_URL + SUPABASE_SERVICE_KEY to run
 * against the real database. This setup file loads them from .env.local
 * without requiring `dotenv` as a dependency.
 *
 * Shell env vars take precedence (not overwritten).
 */

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const envPath = resolve(process.cwd(), '.env.local')

if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}
