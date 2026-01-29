// features/ingestion/service.ts


import { google, gmail_v1 } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { IngestedEmail } from './types';
import { Buffer } from 'buffer';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!
);

/**
 * Helper: Parse raw Gmail message into domain object
 */
export function parseGmailMessage(msg: gmail_v1.Schema$Message): IngestedEmail | null {
  if (!msg.payload || !msg.id) return null;

  const headers = msg.payload.headers || [];
  const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  const from = getHeader('from');
  const subject = getHeader('subject');
  const to = getHeader('to');
  const messageId = getHeader('message-id');

  let bodyPlain = '';
  let bodyHtml = '';

  // Safe Decoder for URL-safe Base64 (RFC 4648)
  const decode = (str: string) => {
    const safeStr = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(safeStr, 'base64').toString('utf-8');
  };

  // Recursive part parser
  const parseParts = (parts: gmail_v1.Schema$MessagePart[]) => {
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        bodyPlain += decode(part.body.data);
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        bodyHtml += decode(part.body.data);
      } else if (part.parts) {
        parseParts(part.parts);
      }
    }
  };

  parseParts(msg.payload.parts || [msg.payload]);

  // Fallback if no plain text
  if (!bodyPlain && bodyHtml) {
    bodyPlain = bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return {
    id: msg.id,
    threadId: msg.threadId || msg.id,
    universalId: messageId ? `GMAIL:${messageId}` : `GMAIL_ID:${msg.id}`,
    from,
    to,
    subject,
    bodyPlain,
    bodyHtml,
    receivedAt: new Date(parseInt(msg.internalDate || Date.now().toString())).toISOString()
  };
}

/**
 * Service: Fetch and Store Emails
 */
export async function ingestRecentEmails(userId: string, googleTokens: any): Promise<IngestedEmail[]> {
  // 1. Setup Gmail Client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials(googleTokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // 2. Fetch Unread Inbox
  const response = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    q: 'is:unread',
    maxResults: 10
  });

  const messages = response.data.messages || [];
  const results: IngestedEmail[] = [];

  for (const msgStub of messages) {
    if (!msgStub.id) continue;

    // 3. Idempotency Check (Fast Fail)
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('external_id', msgStub.id)
      .maybeSingle();

    if (existing) {
      console.log(`[Ingestion] Skipping duplicate ${msgStub.id}`);
      continue;
    }

    // 4. Fetch Full Details
    const fullMsg = await gmail.users.messages.get({
      userId: 'me',
      id: msgStub.id,
      format: 'full'
    });

    const email = parseGmailMessage(fullMsg.data);
    if (!email) continue;

    // 5. Store in DB (Raw Message)
    const { error } = await supabase.from('messages').insert({
      user_id: userId,
      external_id: email.id,
      external_thread_id: email.threadId,
      universal_message_id: email.universalId,
      raw_text: email.bodyPlain,
      cleaned_text: email.bodyPlain,
      timestamp: email.receivedAt,
      direction: 'inbound'
    });

    if (error) {
      console.error(`[Ingestion] DB Error: ${error.message}`);
      continue;
    }

    results.push(email);
  }

  return results;
}
