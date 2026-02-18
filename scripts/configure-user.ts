import { config } from 'dotenv'
config({ path: '.env.local' })
import { createInterface } from 'readline'
import { readFileSync } from 'fs'
import { getUserById, getUserSettings, updateUserSettings } from '../src/lib/db/users'
import { DEFAULT_USER_SETTINGS } from '../src/lib/supabase/types'
import type { UserSettings } from '../src/lib/supabase/types'
import { createBriefSchedules, updateBriefSchedules } from '../src/lib/qstash/client'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
})

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function askNumber(question: string, defaultValue: number): Promise<number> {
  const answer = await ask(question, String(defaultValue))
  const num = Number(answer)
  return isNaN(num) ? defaultValue : num
}

async function askChoice<T extends string>(question: string, choices: T[], defaultValue: T): Promise<T> {
  const choiceStr = choices.map(c => c === defaultValue ? `[${c}]` : c).join(' / ')
  const answer = await ask(`${question} (${choiceStr})`)
  if (!answer) return defaultValue
  const match = choices.find(c => c.toLowerCase() === answer.toLowerCase())
  return match || defaultValue
}

async function askDays(question: string, defaultValue: number[]): Promise<number[]> {
  const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const defaultStr = defaultValue.map(d => dayNames[d]).join(',')
  const answer = await ask(`${question} (comma-separated: Mon,Tue,Wed,Thu,Fri,Sat,Sun)`, defaultStr)
  if (!answer) return defaultValue

  const mapping: Record<string, number> = {
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  }
  const days = answer.split(',')
    .map(d => mapping[d.trim().toLowerCase()])
    .filter((d): d is number => d !== undefined)
    .sort()

  return days.length > 0 ? days : defaultValue
}

function printSection(title: string) {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(50))
}

async function configureInteractive(existing: UserSettings): Promise<Partial<UserSettings>> {
  const settings: Partial<UserSettings> = {}

  // ── Section 1: Client Identity ──
  printSection('Client Identity')

  settings.client_name = await ask('Full name', existing.client_name || undefined)
  settings.client_company = await ask('Company name', existing.client_company || undefined)
  settings.client_role = await ask('Role/title', existing.client_role || undefined)
  settings.client_phone = await ask('Phone number (with country code)', existing.client_phone || undefined)
  settings.client_whatsapp = await ask('WhatsApp number (or same as phone)', existing.client_whatsapp || existing.client_phone || undefined)

  // ── Section 2: Business Context ──
  printSection('Business Context')

  settings.business_type = await ask('Business type (e.g., real estate, consulting)', existing.business_type || undefined)
  settings.business_market = await ask('Market (e.g., Prague luxury residential)', existing.business_market || undefined)
  settings.business_specialization = await ask('Specialization', existing.business_specialization || undefined)
  settings.typical_deal_size_currency = await ask('Deal currency', existing.typical_deal_size_currency)
  settings.typical_deal_size_min = await askNumber('Typical deal size (min)', existing.typical_deal_size_min)
  settings.typical_deal_size_max = await askNumber('Typical deal size (max)', existing.typical_deal_size_max)

  // ── Section 3: AI Persona ──
  printSection('AI Persona')

  settings.ai_name = await ask('AI assistant name', existing.ai_name)
  settings.ai_language = await ask('Language code (e.g., cs, en, de)', existing.ai_language)
  settings.ai_email_signature = await ask('Email signature (single line, use \\n for newlines)', existing.ai_email_signature || undefined)
  settings.ai_system_context = await ask('Extra system context for AI (optional)', existing.ai_system_context || undefined)

  // ── Section 4: Working Hours ──
  printSection('Working Hours & Timezone')

  settings.timezone = await ask('Timezone', existing.timezone)
  settings.working_hours_start = await askNumber('Work start hour (0-23)', existing.working_hours_start)
  settings.working_hours_end = await askNumber('Work end hour (0-23)', existing.working_hours_end)
  settings.working_days = await askDays('Working days', existing.working_days)
  settings.morning_brief_time = await ask('Morning brief time (HH:MM)', existing.morning_brief_time)

  // ── Section 5: Meetings & Travel ──
  printSection('Meetings & Travel')

  settings.default_meeting_duration = await askNumber('Default meeting duration (minutes)', existing.default_meeting_duration)
  settings.default_meeting_type = await askChoice('Default meeting type', ['online', 'in-person'] as const, existing.default_meeting_type as 'online' | 'in-person')
  settings.meeting_buffer_minutes = await askNumber('Buffer between meetings (minutes)', existing.meeting_buffer_minutes)
  settings.travel_mode = await askChoice('Travel mode', ['driving', 'walking', 'transit', 'bicycling'] as const, existing.travel_mode)
  settings.home_location = await ask('Home address (for travel time calc)', existing.home_location || undefined)
  settings.office_location = await ask('Office address', existing.office_location || undefined)

  // ── Section 6: Calendar ──
  // Business calendar uses 'primary' (Google API = authenticated user's main calendar)
  // Only ask about personal calendar
  printSection('Calendar')

  console.log('  Business calendar: using your primary Google Calendar automatically.')
  settings.business_calendar_id = 'primary'
  const hasPersonalCal = await ask('Do you have a separate personal calendar to block time from?', 'no')
  if (hasPersonalCal.toLowerCase() === 'yes' || hasPersonalCal.toLowerCase() === 'y') {
    settings.personal_calendar_id = await ask('Personal calendar ID (find in Google Calendar → Settings → calendar ID)')
  } else {
    settings.personal_calendar_id = null
  }

  // ── Section 7: Advanced ──
  console.log('\n── Advanced Settings (current defaults) ──')
  console.log('')
  console.log('  Lead tracking:')
  console.log(`    No reply in ${existing.cooling_threshold_days} days  → gentle check-in`)
  console.log(`    No reply in ${existing.cold_threshold_days} days  → urgent follow-up`)
  console.log(`    No reply in ${existing.dead_threshold_days} days → last-chance contact`)
  console.log(`    Max ${existing.max_auto_follow_ups} auto follow-ups per conversation`)
  console.log('')
  console.log('  Scoring:')
  console.log(`    Seller deals get ${existing.offer_multiplier_seller}x priority boost`)
  console.log(`    Buyer deals get ${existing.offer_multiplier_buyer}x priority boost`)
  console.log(`    VIP contacts get ${existing.priority_multiplier_vip}x priority boost`)
  console.log('')
  console.log('  WhatsApp: ' + (existing.whatsapp_enabled ? `enabled (port ${existing.whatsapp_daemon_port})` : 'disabled'))
  console.log('')

  const changeAdvanced = await ask('Change any of these?', 'no')

  if (changeAdvanced.toLowerCase() === 'yes' || changeAdvanced.toLowerCase() === 'y') {
    printSection('Lead Tracking')
    console.log('  How many days of silence before Mila follows up automatically?\n')

    settings.cooling_threshold_days = await askNumber('Days before gentle check-in', existing.cooling_threshold_days)
    settings.cold_threshold_days = await askNumber('Days before urgent follow-up', existing.cold_threshold_days)
    settings.dead_threshold_days = await askNumber('Days before last-chance contact', existing.dead_threshold_days)
    settings.max_auto_follow_ups = await askNumber('Max auto follow-ups per conversation', existing.max_auto_follow_ups)

    printSection('Scoring')
    console.log('  Priority multipliers — higher = more important in the morning brief.\n')

    settings.offer_multiplier_seller = await askNumber('Seller deal multiplier', existing.offer_multiplier_seller)
    settings.offer_multiplier_buyer = await askNumber('Buyer deal multiplier', existing.offer_multiplier_buyer)
    settings.priority_multiplier_vip = await askNumber('VIP contact multiplier', existing.priority_multiplier_vip)

    printSection('WhatsApp')
    console.log('  Requires the WhatsApp daemon running separately (see docs).\n')

    const waEnabled = await ask('Enable WhatsApp?', existing.whatsapp_enabled ? 'yes' : 'no')
    settings.whatsapp_enabled = waEnabled.toLowerCase() === 'yes' || waEnabled.toLowerCase() === 'y'
    if (settings.whatsapp_enabled) {
      settings.whatsapp_daemon_port = await askNumber('WhatsApp daemon port', existing.whatsapp_daemon_port)
    }
  }

  return settings
}

async function main() {
  const args = process.argv.slice(2)

  // Support --from-json <path> for non-interactive use
  const jsonFlagIndex = args.indexOf('--from-json')
  let fromJsonPath: string | null = null
  if (jsonFlagIndex !== -1 && args[jsonFlagIndex + 1]) {
    fromJsonPath = args[jsonFlagIndex + 1]
  }

  // Support --user-id <id> to skip interactive prompt (used by add-user.ts chaining)
  const userIdFlagIndex = args.indexOf('--user-id')
  let userIdArg: string | null = null
  if (userIdFlagIndex !== -1 && args[userIdFlagIndex + 1]) {
    userIdArg = args[userIdFlagIndex + 1]
  }

  console.log('--- Mila User Settings Configuration ---')
  console.log('Step 2: Configure user settings (run after add-user.ts)\n')

  const userId = userIdArg || await ask('Enter user ID (UUID from add-user.ts)')
  if (!userId) {
    console.error('User ID is required')
    process.exit(1)
  }

  // Verify user exists
  const user = await getUserById(userId)
  if (!user) {
    console.error(`User not found: ${userId}`)
    console.error('Run add-user.ts first to create the user.')
    process.exit(1)
  }

  console.log(`\nFound user: ${user.email}`)

  // Load existing settings (with defaults applied)
  const existing = await getUserSettings(userId)

  let settingsToApply: Partial<UserSettings>

  if (fromJsonPath) {
    // Non-interactive: load from JSON file
    console.log(`\nLoading settings from: ${fromJsonPath}`)
    try {
      const raw = readFileSync(fromJsonPath, 'utf-8')
      settingsToApply = JSON.parse(raw) as Partial<UserSettings>
    } catch (err) {
      console.error(`Failed to read/parse JSON file: ${err}`)
      process.exit(1)
    }
  } else {
    // Interactive mode
    settingsToApply = await configureInteractive(existing)
  }

  // Merge: existing DB settings + new values (strip empty strings that mean "keep default")
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(settingsToApply)) {
    if (value !== '' && value !== undefined) {
      merged[key] = value
    }
  }

  // Preview
  console.log('\n── Settings to save ──')
  const preview: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(merged)) {
    const defaultVal = DEFAULT_USER_SETTINGS[key as keyof UserSettings]
    if (JSON.stringify(value) !== JSON.stringify(defaultVal)) {
      preview[key] = value
    }
  }
  if (Object.keys(preview).length > 0) {
    console.log(JSON.stringify(preview, null, 2))
  } else {
    console.log('(all defaults — no custom values)')
  }

  const confirm = await ask('\nSave these settings?', 'yes')
  if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
    console.log('Aborted.')
    process.exit(0)
  }

  await updateUserSettings(userId, merged)
  console.log('\nSettings saved successfully.')

  // Create or update QStash brief schedules
  if (process.env.QSTASH_TOKEN) {
    try {
      const morningTime = (merged.morning_brief_time as string) || '08:00'
      const afternoonTime = (merged.afternoon_brief_time as string) || '13:00'
      const tz = (merged.timezone as string) || 'Europe/Prague'
      const oldMorningId = (existing.qstash_morning_schedule_id as string | null) || null
      const oldAfternoonId = (existing.qstash_afternoon_schedule_id as string | null) || null

      console.log('\nSetting up QStash brief schedules...')
      const scheduleIds = oldMorningId || oldAfternoonId
        ? await updateBriefSchedules(userId, oldMorningId, oldAfternoonId, morningTime, afternoonTime, tz)
        : await createBriefSchedules(userId, morningTime, afternoonTime, tz)

      // Save schedule IDs back to settings
      await updateUserSettings(userId, {
        ...merged,
        qstash_morning_schedule_id: scheduleIds.morningScheduleId,
        qstash_afternoon_schedule_id: scheduleIds.afternoonScheduleId,
      })
      console.log(`  Morning brief: ${morningTime} ${tz} (schedule: ${scheduleIds.morningScheduleId})`)
      console.log(`  Afternoon brief: ${afternoonTime} ${tz} (schedule: ${scheduleIds.afternoonScheduleId})`)
    } catch (err) {
      console.error('\nFailed to set up QStash schedules:', err)
      console.error('You can set them up manually later or re-run this script.')
    }
  } else {
    console.log('\nSkipping QStash schedule setup (QSTASH_TOKEN not set).')
  }

  console.log(`\nUser ${user.email} (${userId}) is now configured.`)

  rl.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
