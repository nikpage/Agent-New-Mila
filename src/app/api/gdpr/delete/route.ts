import { NextRequest, NextResponse } from 'next/server'
import { verifyApiKey } from '@/lib/auth/api'
import { getUserById } from '@/lib/db/users'
import { deleteAllUserData, writeAuditLog } from '@/lib/db/gdpr'

/**
 * GDPR Art. 17 — Right to Erasure.
 * Deletes ALL data for a user across every table. Irreversible.
 *
 * POST /api/gdpr/delete
 * Body: { userId: string }
 * Auth: x-api-key header
 */
export async function POST(request: NextRequest) {
  const authError = verifyApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const { userId } = body

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  // Verify user exists before deletion
  const user = await getUserById(userId)
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'

  // Write audit log BEFORE deletion (FK is ON DELETE SET NULL so it survives)
  await writeAuditLog({
    user_id: userId,
    action: 'gdpr_data_deletion',
    details: { email: user.email, requested_at: new Date().toISOString() },
    ip_address: ip,
  })

  try {
    const counts = await deleteAllUserData(userId)

    // Write a post-deletion audit entry (user_id will be null since user is deleted)
    await writeAuditLog({
      user_id: userId, // will become NULL due to SET NULL FK
      action: 'gdpr_data_deletion_completed',
      details: { original_email: user.email, deleted_counts: counts },
      ip_address: ip,
    })

    return NextResponse.json({
      success: true,
      message: 'All user data has been permanently deleted',
      deleted: counts,
    })
  } catch (error) {
    console.error('[GDPR] Deletion failed:', error)
    return NextResponse.json(
      { error: 'Deletion failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
