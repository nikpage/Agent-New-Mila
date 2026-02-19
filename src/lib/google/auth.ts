import { google } from 'googleapis'
import { getUserById, updateUserGoogleTokens, type GoogleTokens } from '../db/users'
import { decryptTokens } from '../crypto'

/**
 * In-memory OAuth token cache.
 * Avoids hitting Supabase on every Gmail/Calendar API call (tens of thousands
 * of redundant reads per cron cycle at 500 users).
 *
 * Cache entry holds the GoogleTokens object + a `cachedAt` timestamp.
 * TTL = 4 minutes (tokens are proactively refreshed when < 5 min to expiry,
 * so a 4-min cache ensures we always re-check before the refresh window).
 */
interface CachedToken {
  tokens: GoogleTokens
  cachedAt: number
}

const TOKEN_CACHE_TTL_MS = 4 * 60 * 1000 // 4 minutes
const tokenCache = new Map<string, CachedToken>()

/** Invalidate cache for a user (called after token refresh). */
function invalidateTokenCache(userId: string) {
  tokenCache.delete(userId)
}

/** Get cached tokens if still valid. */
function getCachedTokens(userId: string): GoogleTokens | null {
  const entry = tokenCache.get(userId)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > TOKEN_CACHE_TTL_MS) {
    tokenCache.delete(userId)
    return null
  }
  return entry.tokens
}

/** Store tokens in cache. */
function setCachedTokens(userId: string, tokens: GoogleTokens) {
  tokenCache.set(userId, { tokens, cachedAt: Date.now() })
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]

/**
 * Get OAuth2 client configuration
 */
function getOAuth2Config() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI
  console.log('DEBUG: OAuth Config:', {
    clientId: clientId ? '...exists' : 'MISSING',
    redirectUri: `'${redirectUri}'`
  })

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing Google OAuth configuration')
  }

  return { clientId, clientSecret, redirectUri }
}

/**
 * Create a new OAuth2 client
 */
export function createOAuth2Client() {
  const { clientId, clientSecret, redirectUri } = getOAuth2Config()
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

/**
 * Generate authorization URL for user consent
 */
export function getAuthorizationUrl(state?: string): string {
  const oauth2Client = createOAuth2Client()

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  })
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
  const oauth2Client = createOAuth2Client()
  const { tokens } = await oauth2Client.getToken(code)

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Failed to get tokens from authorization code')
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date || Date.now() + 3600 * 1000,
    scope: tokens.scope || SCOPES.join(' '),
    token_type: tokens.token_type || 'Bearer',
  }
}

/**
 * Get authenticated OAuth2 client for a user.
 * Uses in-memory token cache to avoid redundant DB reads.
 * Automatically refreshes token if expired.
 */
export async function getAuthenticatedClient(userId: string) {
  // Try cache first — avoids DB hit on every API call
  let tokens = getCachedTokens(userId)

  if (!tokens) {
    const user = await getUserById(userId)

    // Try encrypted tokens first, fall back to plaintext
    if (user?.encrypted_google_tokens) {
      try {
        tokens = decryptTokens(user.encrypted_google_tokens) as GoogleTokens
      } catch (err) {
        console.error('Failed to decrypt tokens for user', userId, '— falling back to plaintext:', err)
        tokens = null as unknown as GoogleTokens
      }
    }

    if (!tokens && user?.google_oauth_tokens) {
      tokens = user.google_oauth_tokens as unknown as GoogleTokens
    }

    if (!tokens) {
      throw new Error('User has no Google OAuth tokens')
    }

    setCachedTokens(userId, tokens)
  }

  const oauth2Client = createOAuth2Client()

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  })

  // Check if token needs refresh (5 minutes before expiry)
  const needsRefresh = tokens.expiry_date < Date.now() + 5 * 60 * 1000

  if (needsRefresh && tokens.refresh_token) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken()

      const newTokens: GoogleTokens = {
        access_token: credentials.access_token || tokens.access_token,
        refresh_token: credentials.refresh_token || tokens.refresh_token,
        expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
        scope: tokens.scope,
        token_type: tokens.token_type,
      }

      // Persist to DB and update cache
      await updateUserGoogleTokens(userId, newTokens)
      invalidateTokenCache(userId)
      setCachedTokens(userId, newTokens)

      oauth2Client.setCredentials({
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expiry_date: newTokens.expiry_date,
      })
    } catch (error) {
      invalidateTokenCache(userId)
      console.error('Failed to refresh token:', error)
      throw new Error('Failed to refresh Google OAuth token. User may need to re-authenticate.')
    }
  }

  return oauth2Client
}

/**
 * Revoke user's Google access
 */
export async function revokeAccess(userId: string): Promise<void> {
  const user = await getUserById(userId)

  if (!user?.google_oauth_tokens) {
    return
  }

  const tokens = user.google_oauth_tokens as unknown as GoogleTokens
  const oauth2Client = createOAuth2Client()

  try {
    await oauth2Client.revokeToken(tokens.access_token)
  } catch {
    // Token may already be invalid, continue
  }
}

/**
 * Check if user has valid Google credentials
 */
export async function hasValidCredentials(userId: string): Promise<boolean> {
  try {
    await getAuthenticatedClient(userId)
    return true
  } catch {
    return false
  }
}
