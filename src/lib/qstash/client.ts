/**
 * QStash Schedule Management
 * Creates/deletes per-user cron schedules for morning and afternoon briefs.
 */

import { Client } from '@upstash/qstash'

const QSTASH_TOKEN = process.env.QSTASH_TOKEN

function getClient(): Client {
  if (!QSTASH_TOKEN) {
    throw new Error('Missing QSTASH_TOKEN environment variable')
  }
  return new Client({ token: QSTASH_TOKEN })
}

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000'
const CRON_SECRET = process.env.CRON_SECRET

interface BriefScheduleIds {
  morningScheduleId: string
  afternoonScheduleId: string
}

/**
 * Create morning + afternoon brief schedules for a user.
 * Uses the user's configured times and timezone.
 */
export async function createBriefSchedules(
  userId: string,
  morningTime: string,    // "HH:MM" e.g. "08:00"
  afternoonTime: string,  // "HH:MM" e.g. "13:00"
  timezone: string,       // e.g. "Europe/Prague"
): Promise<BriefScheduleIds> {
  const client = getClient()

  const [mHour, mMin] = morningTime.split(':').map(Number)
  const [aHour, aMin] = afternoonTime.split(':').map(Number)

  const morningCron = `CRON_TZ=${timezone} ${mMin} ${mHour} * * *`
  const afternoonCron = `CRON_TZ=${timezone} ${aMin} ${aHour} * * *`

  const headers: Record<string, string> = {}
  if (CRON_SECRET) {
    headers['Authorization'] = `Bearer ${CRON_SECRET}`
  }

  const morningResult = await client.schedules.create({
    destination: `${APP_BASE_URL}/api/cron/morning-brief?userId=${userId}`,
    cron: morningCron,
    headers,
  })

  const afternoonResult = await client.schedules.create({
    destination: `${APP_BASE_URL}/api/cron/morning-brief?userId=${userId}&type=afternoon`,
    cron: afternoonCron,
    headers,
  })

  return {
    morningScheduleId: morningResult.scheduleId,
    afternoonScheduleId: afternoonResult.scheduleId,
  }
}

/**
 * Delete a user's brief schedules.
 */
export async function deleteBriefSchedules(
  morningScheduleId: string | null,
  afternoonScheduleId: string | null,
): Promise<void> {
  const client = getClient()

  if (morningScheduleId) {
    await client.schedules.delete(morningScheduleId)
  }
  if (afternoonScheduleId) {
    await client.schedules.delete(afternoonScheduleId)
  }
}

/**
 * Publish a bulk ingest step to the worker endpoint via QStash.
 * Used to chain Phase 1 batches and subsequent phases without exceeding Vercel timeout.
 */
export async function publishBulkIngestStep(payload: Record<string, unknown>): Promise<string> {
  const client = getClient()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (CRON_SECRET) {
    headers['Authorization'] = `Bearer ${CRON_SECRET}`
  }

  const result = await client.publishJSON({
    url: `${APP_BASE_URL}/api/ingest/bulk/worker`,
    body: payload,
    headers,
  })

  return result.messageId
}

/**
 * Update a user's brief schedules (delete old, create new).
 */
export async function updateBriefSchedules(
  userId: string,
  oldMorningId: string | null,
  oldAfternoonId: string | null,
  morningTime: string,
  afternoonTime: string,
  timezone: string,
): Promise<BriefScheduleIds> {
  await deleteBriefSchedules(oldMorningId, oldAfternoonId)
  return createBriefSchedules(userId, morningTime, afternoonTime, timezone)
}
