import { config } from 'dotenv'
config({ path: '.env.local' })
import { createInterface } from 'readline'
import { readFileSync } from 'fs'
import { getUserById, getUserSettings, updateUserSettings } from '../src/lib/db/users'
import { DEFAULT_USER_SETTINGS } from '../src/lib/supabase/types'
import type { UserSettings } from '../src/lib/supabase/types'

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
  printSection('Calendar')

  settings.business_calendar_id = await ask('Business Google Calendar ID', existing.business_calendar_id)
  const personalCal = await ask('Personal Google Calendar ID (leave empty to skip)', existing.personal_calendar_id || '')
  settings.personal_calendar_id = personalCal || null

  // ── Section 7: Advanced (ask whether to configure) ──
  const configAdvanced = await ask('\nConfigure advanced settings? (lead tracking, scoring, WhatsApp)', 'no')

  if (configAdvanced.toLowerCase() === 'yes' || configAdvanced.toLowerCase() === 'y') {
    printSection('Lead Tracking')

    settings.cooling_threshold_days = await askNumber('Cooling threshold (days inactive)', existing.cooling_threshold_days)
    settings.cold_threshold_days = await askNumber('Cold threshold (days inactive)', existing.cold_threshold_days)
    settings.dead_threshold_days = await askNumber('Dead threshold (days inactive)', existing.dead_threshold_days)
    settings.max_auto_follow_ups = await askNumber('Max auto follow-ups per conversation', existing.max_auto_follow_ups)
    settings.cooling_priority_boost = await askNumber('Cooling priority boost multiplier', existing.cooling_priority_boost)
    settings.cold_priority_boost = await askNumber('Cold priority boost multiplier', existing.cold_priority_boost)
    settings.min_deal_value_for_tracking = await askNumber('Min deal value for lead tracking', existing.min_deal_value_for_tracking)

    printSection('Scoring')

    settings.offer_multiplier_seller = await askNumber('Seller offer multiplier', existing.offer_multiplier_seller)
    settings.offer_multiplier_buyer = await askNumber('Buyer offer multiplier', existing.offer_multiplier_buyer)
    settings.priority_multiplier_vip = await askNumber('VIP priority multiplier', existing.priority_multiplier_vip)
    settings.kc_factor = await askNumber('KC factor', existing.kc_factor)

    printSection('WhatsApp')

    const waEnabled = await ask('Enable WhatsApp?', existing.whatsapp_enabled ? 'yes' : 'no')
    settings.whatsapp_enabled = waEnabled.toLowerCase() === 'yes' || waEnabled.toLowerCase() === 'y'
    if (settings.whatsapp_enabled) {
      settings.whatsapp_daemon_port = await askNumber('WhatsApp daemon port', existing.whatsapp_daemon_port)
      settings.whatsapp_session_data_path = await ask('Session data path', existing.whatsapp_session_data_path)
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
  console.log(`User ${user.email} (${userId}) is now configured.`)

  rl.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
