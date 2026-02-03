import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/client'

export async function GET() {
  const checks: Record<string, { status: 'ok' | 'error'; message?: string }> = {}

  // Check Supabase connection
  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase.from('users').select('id').limit(1)

    if (error) {
      checks.database = { status: 'error', message: error.message }
    } else {
      checks.database = { status: 'ok' }
    }
  } catch (error) {
    checks.database = {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }

  // Check required environment variables
  const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GEMINI_API_KEY',
    'NEXTAUTH_SECRET',
  ]

  const missingEnvVars = requiredEnvVars.filter(name => !process.env[name])

  if (missingEnvVars.length > 0) {
    checks.environment = {
      status: 'error',
      message: `Missing: ${missingEnvVars.join(', ')}`,
    }
  } else {
    checks.environment = { status: 'ok' }
  }

  const allOk = Object.values(checks).every(c => c.status === 'ok')

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 }
  )
}
