import { NextRequest, NextResponse } from 'next/server'
import { validateCronToken } from '@/lib/auth/tokens'
import { getUsersWithEmailEnabled, updateUsersLastChecked, updateUsersLastActivity } from '@/lib/db/users'
import { publishAgentRun } from '@/lib/qstash/client'
import { createOAuth2Client } from '@/lib/google/auth'
import { decryptTokens } from '@/lib/crypto'
import { google } from 'googleapis'
import type { GoogleTokens } from '@/lib/db/users'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * How many users to check for new mail concurrently.
 * Balances speed vs Gmail API rate limits.
 */
const CHECK_BATCH_SIZE = 100

/**
 * Delay between QStash agent run publishes (seconds).
 * At 1s intervals, max ~50 concurrent agent runs at any time
 * (given ~50s average runtime), keeping Supabase connections manageable.
 */
const STAGGER_INTERVAL_SEC = 1

/**
 * Max users to process per invocation. If more exist, the dispatcher
 * chains to itself via QStash with an offset for the next page.
 */
const PAGE_SIZE = 1000

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')

    if (!validateCronToken(token)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const offset = parseInt(request.nextUrl.searchParams.get('offset') || '0', 10)
    const start = Date.now()
    console.log(`\n[Dispatcher] ========== Checking users for new mail ==========`)
    console.log(`[Dispatcher] Time: ${new Date().toISOString()}, Offset: ${offset}`)

    // 1. Fetch all active users with tokens (single query)
    const allUsers = await getUsersWithEmailEnabled()
    const page = allUsers.slice(offset, offset + PAGE_SIZE)

    console.log(`[Dispatcher] Total active users: ${allUsers.length}, Processing: ${page.length} (offset ${offset})`)

    // 2. Filter to users with Google credentials
    const usersWithCreds = page.filter(
      u => u.encrypted_google_tokens || u.google_oauth_tokens
    )
    console.log(`[Dispatcher] Users with credentials: ${usersWithCreds.length}`)

    // 3. Check each user for new mail via history.list
    const usersWithNewMail: string[] = []
    const allCheckedIds: string[] = []
    const errors: string[] = []

    for (let i = 0; i < usersWithCreds.length; i += CHECK_BATCH_SIZE) {
      const batch = usersWithCreds.slice(i, i + CHECK_BATCH_SIZE)

      const results = await Promise.allSettled(
        batch.map(async (user) => {
          // Build a Gmail client directly from the user's tokens
          // (avoids per-user DB query in getAuthenticatedClient)
          let tokens: GoogleTokens | null = null

          if (user.encrypted_google_tokens) {
            try {
              tokens = decryptTokens(user.encrypted_google_tokens as string) as GoogleTokens
            } catch {
              // Fall back to plaintext
            }
          }
          if (!tokens && user.google_oauth_tokens) {
            tokens = user.google_oauth_tokens as unknown as GoogleTokens
          }
          if (!tokens) {
            throw new Error('No valid tokens')
          }

          // Skip token refresh in dispatcher — if expired, agent run handles it
          const oauth2Client = createOAuth2Client()
          oauth2Client.setCredentials({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expiry_date: tokens.expiry_date,
          })

          const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
          const historyId = (user as Record<string, unknown>).gmail_history_id as string | null

          if (!historyId) {
            // No historyId stored — first run, force agent run
            return { userId: user.id, hasNew: true }
          }

          try {
            const response = await gmail.users.history.list({
              userId: 'me',
              startHistoryId: historyId,
              historyTypes: ['messageAdded'],
            })

            const history = response.data.history || []
            return { userId: user.id, hasNew: history.length > 0 }
          } catch (err: unknown) {
            // 404 = historyId expired, treat as new
            if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 404) {
              return { userId: user.id, hasNew: true }
            }
            // 401 = token expired/revoked — skip, don't waste an agent run
            if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 401) {
              console.warn(`[Dispatcher] Skipping user ${user.id} — OAuth token expired (401)`)
              return { userId: user.id, hasNew: false }
            }
            throw err
          }
        })
      )

      for (let j = 0; j < results.length; j++) {
        const r = results[j]
        const user = batch[j]
        allCheckedIds.push(user.id)

        if (r.status === 'fulfilled') {
          if (r.value.hasNew) {
            usersWithNewMail.push(r.value.userId)
          }
        } else {
          errors.push(`${user.id}: ${r.reason instanceof Error ? r.reason.message : 'Unknown error'}`)
        }
      }
    }

    console.log(`[Dispatcher] Users with new mail: ${usersWithNewMail.length}/${allCheckedIds.length}`)
    if (errors.length > 0) {
      console.log(`[Dispatcher] Check errors: ${errors.length}`)
      errors.slice(0, 5).forEach(e => console.error(`[Dispatcher]   ${e}`))
    }

    // 4. Fan out agent runs via QStash with staggered delivery
    let enqueued = 0
    for (let i = 0; i < usersWithNewMail.length; i++) {
      try {
        await publishAgentRun(usersWithNewMail[i], i * STAGGER_INTERVAL_SEC)
        enqueued++
      } catch (pubErr) {
        console.error(`[Dispatcher] Failed to enqueue agent run for ${usersWithNewMail[i]}:`, pubErr)
      }
    }

    // 5. Update timestamps
    await Promise.allSettled([
      updateUsersLastChecked(allCheckedIds),
      updateUsersLastActivity(usersWithNewMail),
    ])

    // 6. Chain to next page if needed
    let chained = false
    if (offset + PAGE_SIZE < allUsers.length) {
      try {
        const { Client } = await import('@upstash/qstash')
        const qstash = new Client({ token: process.env.QSTASH_TOKEN! })
        const nextOffset = offset + PAGE_SIZE
        await qstash.publishJSON({
          url: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/api/agent/dispatch?offset=${nextOffset}`,
          body: {},
          headers: {
            'Authorization': `Bearer ${process.env.CRON_SECRET || ''}`,
          },
        })
        chained = true
        console.log(`[Dispatcher] Chained to next page (offset ${nextOffset})`)
      } catch (chainErr) {
        console.error('[Dispatcher] Failed to chain to next page:', chainErr)
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[Dispatcher] Enqueued: ${enqueued}, Elapsed: ${elapsed}s`)
    console.log(`[Dispatcher] ========== Done ==========\n`)

    return NextResponse.json({
      success: true,
      totalUsers: allUsers.length,
      checked: allCheckedIds.length,
      withNewMail: usersWithNewMail.length,
      enqueued,
      errors: errors.length,
      chained,
      elapsed: `${elapsed}s`,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[Dispatcher] FAILED:', error instanceof Error ? error.message : error)
    return NextResponse.json(
      { error: 'Dispatcher failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
