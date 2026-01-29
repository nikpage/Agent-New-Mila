// features/planning/scheduler.ts

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!
);

const addHours = (date: Date, h: number) => new Date(date.getTime() + h * 60 * 60 * 1000);
const addDays = (date: Date, d: number) => new Date(date.getTime() + d * 24 * 60 * 60 * 1000);

// Helper to check idempotency for events
async function assertEventNotProcessed(title: string, userId: string): Promise<boolean> {
  const { data: existing } = await supabase
    .from('todos')
    .select('id')
    .eq('user_id', userId)
    .eq('description', title)
    .maybeSingle();

  return !existing;
}

async function findFreeSlots(calendar: any, startSearch: Date, durationMins: number, count = 3) {
  const slots:  { start: string; end: string }[] = [];
  let candidate = new Date(startSearch);

  const endSearch = addDays(candidate, 3);

  while (slots.length < count && candidate < endSearch) {
    const hour = candidate.getHours();
    if (hour < 9 || hour > 17) {
      candidate = addHours(candidate, 1);
      continue;
    }

    const endCandidate = new Date(candidate.getTime() + durationMins * 60000);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: candidate.toISOString(),
      timeMax: endCandidate.toISOString(),
      singleEvents: true
    });

    const items = (res.data.items) ?? [];
     if (items.length === 0) {
      slots.push({ start: candidate.toISOString(), end: endCandidate.toISOString() });
      candidate = addHours(candidate, 2);
    } else {
      candidate = addHours(candidate, 1);
    }
  }
  return slots;
}

export async function scheduleAction(
  userId: string,
  googleTokens: any,
  cpId: string,
  classification: any,
  emailData: any,
  threadId: string | null
): Promise<void> {
  // Setup Calendar Client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials(googleTokens);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const actionWords = ['meet', 'call', 'viewing', 'schedule', 'book', 'schůzka', 'prohlídka'];
  const emailText = (emailData.bodyPlain || '').toLowerCase();
  const hasActionWord = actionWords.some(word => emailText.includes(word));

  const isEvent = classification?.category === 'BUSINESS' || classification?.type === 'EVENT';

  if (!hasActionWord && !isEvent) {
    return;
  }

  const duration = classification.event_details?.duration_minutes || 60;
  const requestedTime = classification.event_details?.requested_time
    ? new Date(classification.event_details.requested_time)
    : addDays(new Date(), 1);

  // Check Conflict
  const conflictCheck = await calendar.events.list({
    calendarId: 'primary',
    timeMin: requestedTime.toISOString(),
    timeMax: new Date(requestedTime.getTime() + duration * 60000).toISOString(),
    singleEvents: true
  });

  let draftReply = '';
  const conflictItems = (conflictCheck.data.items) ?? [];

  if (conflictItems.length === 0) {
    // FREE -> Suggest Accept
    draftReply = `Dobrý den, potvrzuji termín ${requestedTime.toLocaleString('cs-CZ')}.`;

    // Tentative Hold
    const summary = classification.summary || classification.summary_czech || "Meeting";
    await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `[HOLD] ${summary}`,
        start: { dateTime: requestedTime.toISOString() },
        end: { dateTime: new Date(requestedTime.getTime() + duration * 60000).toISOString() },
        colorId: '8'
      }
    });

  } else {
    // BUSY -> Suggest Options
    const alternatives = await findFreeSlots(calendar, requestedTime, duration);
    const altText = alternatives.map(s => new Date(s.start).toLocaleString('cs-CZ')).join(', ');
    draftReply = `Bohužel v tento čas nemohu. Hodilo by se vám: ${altText}?`;
  }

  // Save Action to DB (Using Todos as "Action Items")
  const todoDescription = `REPLY DRAFT: ${draftReply}`;

  const canInsert = await assertEventNotProcessed(todoDescription, userId);
  if (!canInsert) return;

  await supabase.from('todos').insert({
    user_id: userId,
    cp_id: cpId,
    thread_id: threadId,
    description: todoDescription,
    status: 'pending',
    due_date: new Date().toISOString().split('T')[0]
  });
}
