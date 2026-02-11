import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/client'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // 1. Security Check
  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')
  const authHeader = request.headers.get('authorization')

  const validKey = process.env.SUPERADMIN_KEY

  if (!validKey) {
    return NextResponse.json(
      { error: 'Server misconfiguration: SUPERADMIN_KEY not set' },
      { status: 500 }
    )
  }

  // Check query param or Bearer token
  const isAuthorized =
    key === validKey ||
    authHeader === `Bearer ${validKey}`

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()

    // 2. Fetch Users & Stats
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, email, email_enabled, created_at, settings, updated_at')
      .order('created_at', { ascending: false })

    if (usersError) throw usersError

    // 3. Fetch Recent Errors (System Health)
    const { data: recentErrors, error: errorsError } = await supabase
      .from('agent_errors')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)

    if (errorsError) throw errorsError

    // 4. Fetch Action Stats (AI Usage Proxy)
    // We'll count actions created in the last 24h as a proxy for activity
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count: actionsLast24h, error: actionsError } = await supabase
      .from('action_proposals')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', oneDayAgo)

    if (actionsError) throw actionsError

    // 5. Aggregate Data
    const stats = {
      totalUsers: users.length,
      activeUsers: users.filter(u => u.email_enabled).length,
      actionsLast24h: actionsLast24h || 0,
      recentErrors: recentErrors.map(e => ({
        id: e.id,
        type: e.agent_type,
        message: e.message_internal,
        time: e.created_at
      })),
      users: users.map(u => ({
        id: u.id,
        email: u.email,
        enabled: u.email_enabled,
        joined: u.created_at,
        lastActive: u.updated_at,
        // safely access settings if it exists
        timezone: (u.settings as any)?.timezone || 'N/A',
        mode: (u.settings as any)?.travel_mode || 'N/A'
      }))
    }

    return NextResponse.json(stats)
  } catch (error: any) {
    console.error('Superadmin Stats Error:', error)
    return NextResponse.json(
      { error: error.message || 'Internal Server Error' },
      { status: 500 }
    )
  }
}
