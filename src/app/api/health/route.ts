import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/client'

export async function GET() {
  // Check required environment variables
  // GEMINI_API_KEY or GEMINI_API_KEYS — either satisfies the requirement
  const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'NEXTAUTH_SECRET',
  ]

  const missing = requiredEnvVars.filter(name => !process.env[name])
  const hasGeminiKey = !!(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS)
  if (!hasGeminiKey) missing.push('GEMINI_API_KEY|GEMINI_API_KEYS')

  if (missing.length > 0) {
    console.error('[Health] Missing env vars:', missing.join(', '))
    return NextResponse.json(
      { status: 'degraded', message: 'Configuration incomplete', missing },
      { status: 503 }
    )
  }

  // Check Supabase connection
  let dbOk = false
  let dbError: string | null = null
  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase.from('users').select('id').limit(1)
    dbOk = !error
    if (error) dbError = error.message
  } catch (err) {
    dbOk = false
    dbError = err instanceof Error ? err.message : String(err)
  }

  if (!dbOk) {
    console.error('[Health] Database check failed:', dbError)
    return NextResponse.json(
      { status: 'degraded', message: 'Database unreachable', error: dbError },
      { status: 503 }
    )
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}
