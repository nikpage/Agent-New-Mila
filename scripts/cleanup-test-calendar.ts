#!/usr/bin/env npx tsx
/**
 * Cleanup test calendar events created by e2e-test.ts
 *
 * Searches Google Calendar for events matching the E2E-TEST marker
 * and test CP names, then deletes them.
 *
 * Usage:
 *   npx tsx scripts/cleanup-test-calendar.ts [userId]
 *
 * Default userId: 9e59bc06-7276-453d-bc2e-f224a0a327e3
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { google } from 'googleapis'
import { getAuthenticatedClient } from '../src/lib/google/auth'

const USER_ID = process.argv[2] || '9e59bc06-7276-453d-bc2e-f224a0a327e3'
const TEST_MARKER = 'E2E-TEST'

// Must match the CP names/emails used in e2e-test.ts
const TEST_CP_NAMES = [
  'Bob',
  'Eva Dvorakova',
  'Martin Kral',
  'Jan Novotny',
]

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

async function main() {
  log(`Cleaning up test calendar events for user ${USER_ID}...`)

  const auth = await getAuthenticatedClient(USER_ID)
  const calendar = google.calendar({ version: 'v3', auth })
  const deletedIds = new Set<string>()

  const queries = [TEST_MARKER, ...TEST_CP_NAMES]

  for (const q of queries) {
    log(`Searching calendar for "${q}"...`)

    let pageToken: string | undefined
    do {
      const list = await calendar.events.list({
        calendarId: 'primary',
        q,
        maxResults: 250,
        singleEvents: false,
        ...(pageToken ? { pageToken } : {}),
      })

      const items = list.data.items || []
      if (items.length > 0) {
        log(`  Found ${items.length} events`)
      }

      for (const event of items) {
        if (!event.id || deletedIds.has(event.id)) continue
        try {
          await calendar.events.delete({ calendarId: 'primary', eventId: event.id })
          deletedIds.add(event.id)
          log(`  Deleted: ${event.summary || event.id}`)
        } catch {
          // Event may already be gone
        }
      }

      pageToken = list.data.nextPageToken ?? undefined
    } while (pageToken)
  }

  log(`Done. Deleted ${deletedIds.size} test calendar events.`)
}

main().catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
