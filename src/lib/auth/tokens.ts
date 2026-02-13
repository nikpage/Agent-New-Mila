import { createHmac, randomBytes } from 'crypto'

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

  return signature === expectedSignature
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

    if (signature !== expectedSignature) {
      return null
    }

    return userId
  } catch {
    return null
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
  return token === cronSecret
}
