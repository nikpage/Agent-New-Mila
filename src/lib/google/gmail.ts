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
    labelIds: ['INBOX'],
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

  if (!userEmail) {
    throw new Error('Could not determine user email address for From header')
  }

  // Build RFC 2822 message
  const messageParts: string[] = []

  messageParts.push(`From: ${userEmail}`)

  // Encode To/Cc/Bcc headers if they contain non-ASCII characters
  // Note: This encodes the entire string. For "Name <email>", it's safer to encode just the name,
  // but Gmail usually handles full encoding gracefully.
  messageParts.push(`To: ${encodeHeader(params.to)}`)

  if (params.cc?.length) {
    messageParts.push(`Cc: ${encodeHeader(params.cc.join(', '))}`)
  }

  if (params.bcc?.length) {
    messageParts.push(`Bcc: ${encodeHeader(params.bcc.join(', '))}`)
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
 * Fetch emails with pagination for bulk historical ingestion.
 * Follows nextPageToken to get all results up to maxTotal.
 */
export async function fetchEmailsPaginated(
  userId: string,
  options?: {
    query?: string
    labelIds?: string[]
    after?: Date
    before?: Date
    maxTotal?: number
  }
): Promise<EmailMessage[]> {
  const gmail = await getGmailClient(userId)

  let query = options?.query || ''
  if (options?.after) {
    query += ` after:${Math.floor(options.after.getTime() / 1000)}`
  }
  if (options?.before) {
    query += ` before:${Math.floor(options.before.getTime() / 1000)}`
  }

  const messages: EmailMessage[] = []
  let pageToken: string | undefined
  const maxTotal = options?.maxTotal || 500
  const BATCH_SIZE = 5 // Fetch 5 messages concurrently

  do {
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      maxResults: Math.min(100, maxTotal - messages.length),
      q: query.trim() || undefined,
      labelIds: options?.labelIds,
      pageToken,
    })

    const msgIds = (listResponse.data.messages || [])
      .filter(msg => msg.id)
      .map(msg => msg.id!)
      .slice(0, maxTotal - messages.length)

    // Fetch full messages in parallel batches
    for (let i = 0; i < msgIds.length; i += BATCH_SIZE) {
      const batch = msgIds.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(id =>
          gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'full',
          })
        )
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const parsed = parseGmailMessage(result.value.data)
          if (parsed) {
            messages.push(parsed)
          }
        } else {
          console.error(`Failed to fetch message:`, result.reason)
        }
      }
    }

    pageToken = listResponse.data.nextPageToken || undefined
  } while (pageToken && messages.length < maxTotal)

  return messages
}

/**
 * Fetch a single page of emails for bulk ingestion.
 * Returns messages and nextPageToken for resumable pagination via QStash.
 */
export interface EmailBatchResult {
  messages: EmailMessage[]
  nextPageToken?: string
}

export async function fetchEmailsBatch(
  userId: string,
  options: {
    query?: string
    after?: Date
    before?: Date
    maxResults?: number
    pageToken?: string
  }
): Promise<EmailBatchResult> {
  const gmail = await getGmailClient(userId)

  let query = options.query || ''
  if (options.after) {
    query += ` after:${Math.floor(options.after.getTime() / 1000)}`
  }
  if (options.before) {
    query += ` before:${Math.floor(options.before.getTime() / 1000)}`
  }

  const maxResults = options.maxResults || 50
  const CONCURRENT = 5

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    q: query.trim() || undefined,
    pageToken: options.pageToken,
  })

  const msgIds = (listResponse.data.messages || [])
    .filter(msg => msg.id)
    .map(msg => msg.id!)

  const messages: EmailMessage[] = []

  for (let i = 0; i < msgIds.length; i += CONCURRENT) {
    const batch = msgIds.slice(i, i + CONCURRENT)
    const results = await Promise.allSettled(
      batch.map(id =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        })
      )
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const parsed = parseGmailMessage(result.value.data)
        if (parsed) messages.push(parsed)
      } else {
        console.error('Failed to fetch message:', result.reason)
      }
    }
  }

  return {
    messages,
    nextPageToken: listResponse.data.nextPageToken || undefined,
  }
}

export interface SendCalendarInviteParams {
  to: string
  organizerEmail: string
  organizerName?: string
  summary: string
  description: string
  location?: string
  startTime: Date
  endTime: Date
  /** Google Calendar event ID — used to build iCal UID for response sync */
  gcalEventId: string
}

/**
 * Send a calendar invite email with Importance: high.
 * Builds an iCalendar REQUEST and sends it inline via Gmail so the recipient
 * sees a calendar invite that is marked Important in their inbox.
 */
export async function sendCalendarInviteEmail(
  userId: string,
  params: SendCalendarInviteParams
): Promise<string> {
  const gmail = await getGmailClient(userId)
  const userEmail = params.organizerEmail

  // Format dates to iCalendar YYYYMMDDTHHMMSSZ format
  const fmtDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const now = new Date()
  const uid = `${params.gcalEventId}@google.com`

  // Build iCalendar content
  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mila//Agent//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmtDate(now)}`,
    `DTSTART:${fmtDate(params.startTime)}`,
    `DTEND:${fmtDate(params.endTime)}`,
    `SUMMARY:${escapeICalText(params.summary)}`,
    `DESCRIPTION:${escapeICalText(params.description)}`,
    ...(params.location ? [`LOCATION:${escapeICalText(params.location)}`] : []),
    `ORGANIZER;CN=${escapeICalText(params.organizerName || userEmail)}:mailto:${userEmail}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${params.to}`,
    'PRIORITY:1',
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  const icsContent = icsLines.join('\r\n')

  // Build multipart/mixed MIME: text/plain (agenda) + text/calendar (invite)
  const boundary = `----=_MilaInvite_${Date.now()}`
  const calBoundary = `----=_MilaAlt_${Date.now()}`

  const createBase64Part = (contentType: string, content: string) => {
    const encoded = Buffer.from(content).toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
    return [
      `Content-Type: ${contentType}; charset="UTF-8"`,
      'Content-Transfer-Encoding: base64',
      '',
      encoded
    ].join('\r\n')
  }

  const messageParts: string[] = []
  messageParts.push(`From: ${params.organizerName ? `${encodeHeader(params.organizerName)} <${userEmail}>` : userEmail}`)
  messageParts.push(`To: ${params.to}`)
  messageParts.push(`Subject: ${encodeHeader(params.summary)}`)
  messageParts.push('MIME-Version: 1.0')
  messageParts.push('Importance: high')
  messageParts.push('X-Priority: 1')
  messageParts.push(`Content-Type: multipart/alternative; boundary="${calBoundary}"`)
  messageParts.push('')

  // Part 1: plain text body (agenda)
  messageParts.push(`--${calBoundary}`)
  messageParts.push(createBase64Part('text/plain', params.description))

  // Part 2: iCalendar invite (shows as calendar invite in mail clients)
  messageParts.push(`--${calBoundary}`)
  const icsEncoded = Buffer.from(icsContent).toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
  messageParts.push('Content-Type: text/calendar; charset="UTF-8"; method=REQUEST')
  messageParts.push('Content-Transfer-Encoding: base64')
  messageParts.push('')
  messageParts.push(icsEncoded)

  messageParts.push(`--${calBoundary}--`)

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
    },
  })

  return response.data.id || ''
}

/**
 * Escape text for iCalendar format (RFC 5545)
 */
function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/**
 * Gmail category labels that indicate non-primary mail.
 * Messages with these labels are skipped during bulk ingestion.
 */
export const GMAIL_SKIP_CATEGORIES = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]

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
