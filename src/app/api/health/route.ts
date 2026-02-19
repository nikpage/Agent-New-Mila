import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/client'

export async function GET() {
  // Check required environment variables
  const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GEMINI_API_KEY',
    'NEXTAUTH_SECRET',
  ]

  const envOk = requiredEnvVars.every(name => !!process.env[name])

  if (!envOk) {
    return NextResponse.json(
      { status: 'degraded', message: 'Configuration incomplete' },
      { status: 503 }
    )
  }

  // Check Supabase connection
  let dbOk = false
  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase.from('users').select('id').limit(1)
    dbOk = !error
  } catch {
    dbOk = false
  }

  if (!dbOk) {
    return NextResponse.json(
      { status: 'degraded', message: 'Database unreachable' },
      { status: 503 }
    )
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 })
}
