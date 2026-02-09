import { google, gmail_v1 } from 'googleapis'
import { getAuthenticatedClient } from './auth'

export interface EmailMessage {
  id: string
  threadId: string
  from: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  htmlBody?: string
  date: Date
  labels: string[]
  isUnread: boolean
}

export interface SendEmailParams {
  to: string
  subject: string
  body: string
  htmlBody?: string
  cc?: string[]
  bcc?: string[]
  inReplyTo?: string
  threadId?: string
}

/**
 * Get Gmail API client for a user
 */
async function getGmailClient(userId: string): Promise<gmail_v1.Gmail> {
  const auth = await getAuthenticatedClient(userId)
  return google.gmail({ version: 'v1', auth })
}

/**
 * Get user's email address
 */
export async function getUserEmail(userId: string): Promise<string> {
  const gmail = await getGmailClient(userId)
  const profile = await gmail.users.getProfile({ userId: 'me' })
  return profile.data.emailAddress || ''
}

/**
 * Fetch recent emails
 */
export async function fetchRecentEmails(
  userId: string,
  options?: {
    maxResults?: number
    query?: string
    labelIds?: string[]
    after?: Date
  }
): Promise<EmailMessage[]> {
  const gmail = await getGmailClient(userId)

  // Build query
  let query = options?.query || ''
  if (options?.after) {
    const afterTimestamp = Math.floor(options.after.getTime() / 1000)
    query += ` after:${afterTimestamp}`
  }

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults: options?.maxResults || 50,
    q: query.trim() || undefined,
    labelIds: options?.labelIds,
  })

  const messages: EmailMessage[] = []

  for (const msg of listResponse.data.messages || []) {
    if (!msg.id) continue

    try {
      const fullMessage = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      })

      const parsed = parseGmailMessage(fullMessage.data)
      if (parsed) {
        messages.push(parsed)
      }
    } catch (error) {
      console.error(`Failed to fetch message ${msg.id}:`, error)
    }
  }

  return messages
}

/**
 * Fetch unread emails
 */
export async function fetchUnreadEmails(
  userId: string,
  maxResults: number = 50
): Promise<EmailMessage[]> {
  return fetchRecentEmails(userId, {
    maxResults,
    labelIds: ['UNREAD', 'INBOX'],
  })
}

/**
 * Parse a Gmail message into our format
 */
function parseGmailMessage(message: gmail_v1.Schema$Message): EmailMessage | null {
  if (!message.id || !message.threadId) return null

  const headers = message.payload?.headers || []

  const getHeader = (name: string): string => {
    const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase())
    return header?.value || ''
  }

  const from = getHeader('From')
  const to = getHeader('To').split(',').map(e => e.trim()).filter(Boolean)
  const cc = getHeader('Cc').split(',').map(e => e.trim()).filter(Boolean)
  const subject = getHeader('Subject')
  const dateStr = getHeader('Date')

  // Extract body
  let body = ''
  let htmlBody = ''

  function extractBody(part: gmail_v1.Schema$MessagePart) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      body = Buffer.from(part.body.data, 'base64').toString('utf-8')
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      htmlBody = Buffer.from(part.body.data, 'base64').toString('utf-8')
    }

    if (part.parts) {
      for (const subPart of part.parts) {
        extractBody(subPart)
      }
    }
  }

  if (message.payload) {
    extractBody(message.payload)
  }

  // If no plain text, extract from HTML
  if (!body && htmlBody) {
    body = htmlBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  return {
    id: message.id,
    threadId: message.threadId,
    from,
    to,
    cc: cc.length > 0 ? cc : undefined,
    subject,
    body,
    htmlBody: htmlBody || undefined,
    date: dateStr ? new Date(dateStr) : new Date(),
    labels: message.labelIds || [],
    isUnread: message.labelIds?.includes('UNREAD') || false,
  }
}

/**
 * Encode subject header for RFC 2047 if it contains non-ASCII characters
 */
function encodeHeader(value: string): string {
  if (/[^\x00-\x7F]/.test(value)) {
    return `=?utf-8?B?${Buffer.from(value).toString('base64')}?=`
  }
  return value
}

/**
 * Send an email (from user's own account to themselves or others)
 */
export async function sendEmail(
  userId: string,
  params: SendEmailParams
): Promise<string> {
  const gmail = await getGmailClient(userId)
  const userEmail = await getUserEmail(userId)

  // Build RFC 2822 message
  const messageParts: string[] = []

  messageParts.push(`From: ${userEmail}`)
  messageParts.push(`To: ${params.to}`)

  if (params.cc?.length) {
    messageParts.push(`Cc: ${params.cc.join(', ')}`)
  }

  if (params.bcc?.length) {
    messageParts.push(`Bcc: ${params.bcc.join(', ')}`)
  }

  messageParts.push(`Subject: ${encodeHeader(params.subject)}`)

  if (params.inReplyTo) {
    messageParts.push(`In-Reply-To: ${params.inReplyTo}`)
    messageParts.push(`References: ${params.inReplyTo}`)
  }

  messageParts.push('MIME-Version: 1.0')

  // Helper to create a base64 encoded body part
  const createBase64Part = (contentType: string, content: string) => {
    const encodedContent = Buffer.from(content).toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
    return [
      `Content-Type: ${contentType}; charset="UTF-8"`,
      'Content-Transfer-Encoding: base64',
      '',
      encodedContent
    ].join('\r\n')
  }

  if (params.htmlBody) {
    const boundary = `----=_Part_${Date.now()}`
    messageParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    messageParts.push('')

    messageParts.push(`--${boundary}`)
    messageParts.push(createBase64Part('text/plain', params.body))

    messageParts.push(`--${boundary}`)
    messageParts.push(createBase64Part('text/html', params.htmlBody))

    messageParts.push(`--${boundary}--`)
  } else {
    messageParts.push(createBase64Part('text/plain', params.body))
  }

  const rawMessage = messageParts.join('\r\n')
  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
      threadId: params.threadId,
    },
  })

  return response.data.id || ''
}

/**
 * Mark a message as read
 */
export async function markAsRead(userId: string, messageId: string): Promise<void> {
  const gmail = await getGmailClient(userId)
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  })
}

/**
 * Get a specific email thread
 */
export async function getThread(
  userId: string,
  threadId: string
): Promise<EmailMessage[]> {
  const gmail = await getGmailClient(userId)

  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  })

  const messages: EmailMessage[] = []

  for (const msg of thread.data.messages || []) {
    const parsed = parseGmailMessage(msg)
    if (parsed) {
      messages.push(parsed)
    }
  }

  return messages.sort((a, b) => a.date.getTime() - b.date.getTime())
}

/**
 * Extract email address from a "Name <email@example.com>" format
 */
export function extractEmailAddress(fromField: string): string {
  const match = fromField.match(/<([^>]+)>/)
  if (match) {
    return match[1].toLowerCase()
  }
  return fromField.trim().toLowerCase()
}

/**
 * Extract name from a "Name <email@example.com>" format
 */
export function extractName(fromField: string): string | null {
  const match = fromField.match(/^([^<]+)</)
  if (match) {
    return match[1].trim().replace(/["']/g, '')
  }
  return null
}
