// features/ingestion/outbound.ts

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { IngestedEmail } from './types';
import { parseGmailMessage } from './service';
import { resolveCounterparty } from '../counterparty/service';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!
);

function extractRecipients(toHeader: string, ccHeader: string = ''): string[] {
  const recipients: string[] = [];

  if (toHeader) {
    const toEmails = toHeader.split(',').map(e => {
      const match = e.match(/<(.+?)>/);
      return (match ? match[1] : e).trim().toLowerCase();
    });
    recipients.push(...toEmails);
  }

  if (ccHeader) {
    const ccEmails = ccHeader.split(',').map(e => {
      const match = e.match(/<(.+?)>/);
      return (match ? match[1] : e).trim().toLowerCase();
    });
    recipients.push(...ccEmails);
  }

  return recipients.filter(e => e.length > 0);
}

export async function ingestOutboundEmails(userId: string, googleTokens: any): Promise<IngestedEmail[]> {
  console.log('Outbound ingestion mode: processing sent emails');

  // 1. Setup Gmail Client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials(googleTokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // 2. Fetch Sent Items
  const response = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['SENT'],
    maxResults: 50,
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

    // Extract recipients to resolve CP
    const recipients = extractRecipients(email.to, '');
    if (recipients.length === 0) continue;

    // We'll use the first recipient for the CP resolution
    const primaryRecipient = recipients[0];
    const cpId = await resolveCounterparty(userId, `<${primaryRecipient}>`);

    // 5. Store in DB (Outbound Message)
    const { error } = await supabase.from('messages').insert({
      user_id: userId,
      cp_id: cpId,
      external_id: email.id,
      external_thread_id: email.threadId,
      universal_message_id: email.universalId,
      raw_text: email.bodyPlain,
      cleaned_text: email.bodyPlain,
      timestamp: email.receivedAt,
      direction: 'outbound'
    });

    if (error) {
      console.error(`[Ingestion-Outbound] DB Error: ${error.message}`);
      continue;
    }

    results.push(email);
  }

  return results;
}
