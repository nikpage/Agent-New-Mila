// features/planning/scheduler.ts

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { AI_MODELS, genAI } from '../shared/ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!
);

/**
 * LOGIC GATE: RESOLVE LOCATION
 * Maps nicknames (e.g., "The Office") to real addresses using
 * User settings or Counterparty JSONB data for travel calculations.
 */
export function resolveLocation(locationName: string, userSettings: any, cpData: any): string {
  if (!locationName) return '';

  // 1. Check User's Saved Locations (from users.settings)
  const savedLocation = userSettings.locations?.find(
    (l: any) => l.label.toLowerCase() === locationName.toLowerCase()
  );
  if (savedLocation) return savedLocation.address;

  // 2. Check Counterparty's Saved Locations (from cps table JSONB 'locations' field)
  const cpLocation = cpData.locations?.find(
    (l: any) => l.label.toLowerCase() === locationName.toLowerCase()
  );
  if (cpLocation) return cpLocation.address;

  return locationName;
}

/**
 * LOGIC GATE: SMART SLOTS
 * Finds free calendar slots respecting User Workday and Travel Buffers.
 */
async function findSmartSlots(
  calendar: any,
  userSettings: any,
  durationMins: number,
  count = 3
) {
  const slots: { start: string; end: string }[] = [];
  const { workday, buffer_minutes = 20 } = userSettings;

  // Total block needed = Buffer + Meeting + Buffer
  const totalBlockNeeded = durationMins + (buffer_minutes * 2);

  let candidate = new Date();
  candidate.setHours(candidate.getHours() + 2); // Start looking 2 hours from now

  const startHour = parseInt(workday.start.split(':')[0]);
  const endHour = parseInt(workday.end.split(':')[0]);

  while (slots.length < count) {
    const hour = candidate.getHours();

    // 1. Workday Gate: If outside hours, move to start of next workday
    if (hour < startHour || hour >= endHour) {
      candidate.setHours(startHour);
      candidate.setMinutes(0);
      candidate.setDate(candidate.getDate() + 1);
      continue;
    }

    const endCandidate = new Date(candidate.getTime() + totalBlockNeeded * 60000);

    // 2. Calendar Conflict Check
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: candidate.toISOString(),
      timeMax: endCandidate.toISOString(),
      singleEvents: true
    });

    if ((res.data.items || []).length === 0) {
      // 3. Found slot: Center the meeting within the buffered block
      const meetingStart = new Date(candidate.getTime() + buffer_minutes * 60000);
      const meetingEnd = new Date(meetingStart.getTime() + durationMins * 60000);

      slots.push({
        start: meetingStart.toISOString(),
        end: meetingEnd.toISOString()
      });
      candidate.setHours(candidate.getHours() + 2);
    } else {
      candidate.setMinutes(candidate.getMinutes() + 30);
    }
  }
  return slots;
}

/**
 * MAIN SERVICE: SCHEDULE ACTION
 * Orchestrates the scheduling proposal for the Morning Brief.
 */
export async function scheduleAction(
  userId: string,
  googleTokens: any,
  cpId: string,
  classification: any,
  emailData: any,
  threadId: string
): Promise<void> {

  // 1. Fetch Context (Settings from User, Extras from CP JSONB)
  const { data: user } = await supabase.from('users').select('settings').eq('id', userId).single();
  const { data: cp } = await supabase.from('cps').select('*').eq('id', cpId).single();

  if (!user?.settings) throw new Error("User settings missing");

  // 2. Setup Google Calendar
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials(googleTokens);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  // 3. Resolve Logistics (Nickname -> Address)
  const rawLocation = classification.event_details?.location || '';
  const resolvedAddress = resolveLocation(rawLocation, user.settings, cp);

  const duration = classification.event_details?.duration_minutes || 60;

  // 4. Find Slots (Applying Workday & Travel Padding)
  const alternatives = await findSmartSlots(calendar, user.settings, duration);

  const altText = alternatives
    .map(s => new Date(s.start).toLocaleString('cs-CZ'))
    .join(', ');

  // 5. Generate Draft using Gemini 2.5 Flash
  const model = genAI.getGenerativeModel({ model: AI_MODELS.writing });
  const prompt = `
    Write a brief, professional Czech response suggesting these times: ${altText}.
    Location: ${resolvedAddress || 'to be determined'}.
    Context: ${emailData.subject}
  `;
  const result = await model.generateContent(prompt);
  const draftReply = result.response.text();

  // 6. Store Action Proposal for Morning Brief
  await supabase.from('action_proposals').insert({
    user_id: userId,
    cp_id: cpId,
    conversation_id: threadId,
    action_type: 'SCHEDULE',
    status: 'pending',
    priority_score: 8, // Default for scheduling, adjusted by planning service
    draft_body_text: draftReply,
    rationale: `Suggested slots based on ${user.settings.workday.start}-${user.settings.workday.end} workday and ${user.settings.buffer_minutes}m travel buffer. Location resolved to: ${resolvedAddress || 'None'}.`,
    payload: {
      resolved_address: resolvedAddress,
      slots: alternatives
    }
  });
}
