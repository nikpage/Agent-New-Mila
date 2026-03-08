#!/usr/bin/env npx tsx
/**
 * Delete ALL Mila-managed calendar events (tagged with milaManaged=true).
 *
 * Usage:
 *   npx tsx scripts/cleanup-mila-calendar.ts [userId]
 *
 * Default userId: 9e59bc06-7276-453d-bc2e-f224a0a327e3
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { google } from 'googleapis'
import { getAuthenticatedClient } from '../src/lib/google/auth'

const USER_ID = process.argv[2] || '9e59bc06-7276-453d-bc2e-f224a0a327e3'

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

async function main() {
  log(`Deleting all Mila-managed calendar events for user ${USER_ID}...`)

  const auth = await getAuthenticatedClient(USER_ID)
  const cal = google.calendar({ version: 'v3', auth })

  let deleted = 0
  let pageToken: string | undefined

  const timeMin = new Date()
  timeMin.setDate(timeMin.getDate() - 30)
  const timeMax = new Date()
  timeMax.setDate(timeMax.getDate() + 90)

  do {
    const list = await cal.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: 250,
      singleEvents: true,
      ...(pageToken ? { pageToken } : {}),
    })

    const items = list.data.items || []

    for (const event of items) {
      if (!event.id) continue
      const isMila = event.extendedProperties?.private?.milaManaged === 'true'
      if (!isMila) continue

      try {
        await cal.events.delete({ calendarId: 'primary', eventId: event.id, sendUpdates: 'none' })
        deleted++
        log(`  Deleted: ${event.summary} | ${event.start?.dateTime || event.start?.date}`)
      } catch {
        log(`  Failed: ${event.summary}`)
      }
    }

    pageToken = list.data.nextPageToken ?? undefined
  } while (pageToken)

  log(`Done. Deleted ${deleted} Mila-managed events.`)
}

main().catch(err => {
  console.error('Fatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
