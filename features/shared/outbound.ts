// features/shared/outbound.ts

import { google } from 'googleapis';

export async function sendGmailMessage(userId: string, googleTokens: any, details: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  // Tokens are passed as JSON objects from the DB/User context, no decryption needed
  oauth2Client.setCredentials(googleTokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Gmail requires base64url encoded RFC822 message
  const utf8Subject = `=?utf-8?B?${Buffer.from(details.subject).toString('base64')}?=`;
  const messageParts = [
    `To: ${details.to}`,
    `Subject: ${utf8Subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    details.body,
  ];
  const message = messageParts.join('\n');

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
      threadId: details.threadId
    },
  });
}
