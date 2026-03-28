/**
 * QStash Schedule Management
 * Creates/deletes per-user cron schedules for morning and afternoon briefs.
 */

import { Client } from '@upstash/qstash'
import type { UserSettings } from '@/lib/supabase/types'

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

// ─── Self-Healing Schedule Check ────────────────────────────────────────────

/**
 * Verify that a user's QStash brief schedules exist and are healthy.
 * If schedule IDs are missing from settings or the schedules no longer exist in QStash,
 * recreates them and saves the new IDs. Called at the start of sendMorningBrief()
 * so broken schedules are detected and repaired automatically.
 *
 * Returns true if schedules were recreated, false if they were already healthy.
 */
export async function ensureBriefSchedules(
  userId: string,
  settings: UserSettings,
  updateSettings: (userId: string, patch: Record<string, unknown>) => Promise<void>,
): Promise<boolean> {
  if (!QSTASH_TOKEN) return false

  const client = getClient()
  const morningId = settings.qstash_morning_schedule_id
  const afternoonId = settings.qstash_afternoon_schedule_id

  // Check if both schedule IDs exist in settings and are still alive in QStash
  let needsRecreate = false

  if (!morningId || !afternoonId) {
    needsRecreate = true
  } else {
    // Verify both schedules still exist in QStash
    const [morningAlive, afternoonAlive] = await Promise.all([
      client.schedules.get(morningId).then(() => true).catch(() => false),
      client.schedules.get(afternoonId).then(() => true).catch(() => false),
    ])

    if (!morningAlive || !afternoonAlive) {
      needsRecreate = true
      // Clean up any surviving orphan
      if (morningAlive && !afternoonAlive) {
        await client.schedules.delete(morningId).catch(() => {})
      }
      if (!morningAlive && afternoonAlive) {
        await client.schedules.delete(afternoonId).catch(() => {})
      }
    }
  }

  if (!needsRecreate) return false

  console.log(`[QStash] Schedules missing or dead for user ${userId} — recreating`)

  const morningTime = settings.morning_brief_time || '08:00'
  const afternoonTime = settings.afternoon_brief_time || '13:00'
  const tz = settings.timezone || 'Europe/Prague'

  const scheduleIds = await createBriefSchedules(userId, morningTime, afternoonTime, tz)

  await updateSettings(userId, {
    qstash_morning_schedule_id: scheduleIds.morningScheduleId,
    qstash_afternoon_schedule_id: scheduleIds.afternoonScheduleId,
  })

  console.log(`[QStash] Recreated schedules for ${userId}: morning=${scheduleIds.morningScheduleId}, afternoon=${scheduleIds.afternoonScheduleId}`)
  return true
}

// ─── Instant Notify Polling ─────────────────────────────────────────────────

/**
 * Create a global QStash schedule that polls for high-priority actions
 * every 5 minutes and sends instant notification emails.
 * This is a single global schedule (not per-user).
 */
export async function createInstantNotifySchedule(): Promise<string> {
  const client = getClient()

  const headers: Record<string, string> = {}
  if (CRON_SECRET) {
    headers['Authorization'] = `Bearer ${CRON_SECRET}`
  }

  const result = await client.schedules.create({
    destination: `${APP_BASE_URL}/api/cron/instant-notify`,
    cron: '*/5 * * * *',
    headers,
  })

  return result.scheduleId
}

/**
 * Delete the instant-notify polling schedule.
 */
export async function deleteInstantNotifySchedule(
  scheduleId: string
): Promise<void> {
  const client = getClient()
  await client.schedules.delete(scheduleId)
}
