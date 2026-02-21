import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Generate a secure action token
 * Token format: actionId.timestamp.signature
 */
export function generateActionToken(actionId: string, userId: string): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET not configured')
  }

  const timestamp = Date.now().toString()
  const payload = `${actionId}.${userId}.${timestamp}`

  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 32)

  return `${timestamp}.${signature}`
}

/**
 * Validate an action token
 * Returns true if valid, false otherwise
 */
export function validateActionToken(
  token: string,
  actionId: string,
  userId: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000 // 7 days default
): boolean {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET not configured')
  }

  const parts = token.split('.')
  if (parts.length !== 2) {
    return false
  }

  const [timestamp, signature] = parts

  // Check expiry
  const tokenTime = parseInt(timestamp, 10)
  if (isNaN(tokenTime) || Date.now() - tokenTime > maxAgeMs) {
    return false
  }

  // Verify signature
  const payload = `${actionId}.${userId}.${timestamp}`
  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 32)

  if (signature.length !== expectedSignature.length) return false
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  } catch {
    return false
  }
}

/**
 * Generate a random state string for OAuth
 */
export function generateOAuthState(userId: string): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET not configured')
  }

  const nonce = randomBytes(16).toString('hex')
  const timestamp = Date.now().toString()
  const payload = `${userId}.${timestamp}.${nonce}`

  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16)

  // Base64 encode for URL safety
  return Buffer.from(`${payload}.${signature}`).toString('base64url')
}

/**
 * Validate and extract user ID from OAuth state
 */
export function validateOAuthState(
  state: string,
  maxAgeMs: number = 10 * 60 * 1000 // 10 minutes
): string | null {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    return null
  }

  try {
    const decoded = Buffer.from(state, 'base64url').toString()
    const parts = decoded.split('.')

    if (parts.length !== 4) {
      return null
    }

    const [userId, timestamp, nonce, signature] = parts

    // Check expiry
    const stateTime = parseInt(timestamp, 10)
    if (isNaN(stateTime) || Date.now() - stateTime > maxAgeMs) {
      return null
    }

    // Verify signature
    const payload = `${userId}.${timestamp}.${nonce}`
    const expectedSignature = createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .slice(0, 16)

    if (signature.length !== expectedSignature.length) return null
    try {
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return null
      }
    } catch {
      return null
    }

    return userId
  } catch {
    return null
  }
}

/**
 * Generate HMAC signature for the trigger/ingest tracking pixel URL.
 * Unlike action tokens these do NOT expire — the pixel URL is baked into
 * every brief email we've ever sent. Replay is limited because the route
 * only fires an agent run, not a destructive action.
 */
export function generateTriggerToken(userId: string): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error('NEXTAUTH_SECRET not configured')

  return createHmac('sha256', secret)
    .update(`trigger.${userId}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Validate a trigger token.
 * Returns true only if the HMAC matches the userId.
 */
export function validateTriggerToken(token: string, userId: string): boolean {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) return false

  const expected = createHmac('sha256', secret)
    .update(`trigger.${userId}`)
    .digest('hex')
    .slice(0, 32)

  // Timing-safe comparison
  if (token.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

/**
 * Generate a signed token for backfill report action links.
 * Token format: timestamp.signature
 * Encodes: userId + operation (allow/blacklist/add) + target (email/cpId/convId)
 */
export function generateBackfillToken(userId: string, operation: string, target: string): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error('NEXTAUTH_SECRET not configured')

  const timestamp = Date.now().toString()
  const payload = `backfill.${userId}.${operation}.${target}.${timestamp}`

  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 32)

  return `${timestamp}.${signature}`
}

/**
 * Validate a backfill report action token.
 * Returns true if the HMAC matches and the token has not expired.
 */
export function validateBackfillToken(
  token: string,
  userId: string,
  operation: string,
  target: string,
  maxAgeMs: number = 30 * 24 * 60 * 60 * 1000 // 30 days — report links live longer
): boolean {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) return false

  const parts = token.split('.')
  if (parts.length !== 2) return false

  const [timestamp, signature] = parts

  const tokenTime = parseInt(timestamp, 10)
  if (isNaN(tokenTime) || Date.now() - tokenTime > maxAgeMs) return false

  const payload = `backfill.${userId}.${operation}.${target}.${timestamp}`
  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 32)

  if (signature.length !== expectedSignature.length) return false
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  } catch {
    return false
  }
}

/**
 * Validate cron authentication token
 * SECURITY: Only allows cron jobs when CRON_SECRET is properly configured
 */
export function validateCronToken(token: string | null | undefined): boolean {
  // Use bracket notation to prevent Next.js/SWC from inlining this at compile time
  const cronSecret = process.env['CRON_SECRET']

  if (!cronSecret) {
    console.error('CRON_SECRET not configured — cron endpoints are disabled')
    return false // reject if not configured
  }

  // In development, still require the secret for security consistency
  if (!token || token.length !== cronSecret.length) return false
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret))
  } catch {
    return false
  }
}
