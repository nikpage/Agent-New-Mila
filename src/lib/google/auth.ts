import { google } from 'googleapis'
import { getUserById, updateUserGoogleTokens, type GoogleTokens } from '../db/users'

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
 * Get authenticated OAuth2 client for a user
 * Automatically refreshes token if expired
 */
export async function getAuthenticatedClient(userId: string) {
  const user = await getUserById(userId)

  if (!user?.google_oauth_tokens) {
    throw new Error('User has no Google OAuth tokens')
  }

  const tokens = user.google_oauth_tokens as unknown as GoogleTokens
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

      // Update tokens in database
      await updateUserGoogleTokens(userId, newTokens)

      oauth2Client.setCredentials({
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expiry_date: newTokens.expiry_date,
      })
    } catch (error) {
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
