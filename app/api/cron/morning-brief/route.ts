// app/api/cron/morning-brief/route.ts

import { createClient } from '@supabase/supabase-js';
import { AI_MODELS } from '../../../../lib/ai/config';
import { genAI } from '../../../../features/shared/ai';
import { sendGmailMessage } from '../../../../features/shared/outbound';

export async function GET(req: Request) {
  // Verify Cron Secret to prevent unauthorized triggers
  if (req.headers.get('Authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  // 1. Fetch all users to process
  const { data: users } = await supabase.from('users').select('id, email, google_oauth_tokens, settings');

  for (const user of users!) {
    // 2. Get pending proposals for this user
    const { data: proposals } = await supabase
      .from('action_proposals')
      .select('*, cps(name, role)')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .order('priority_score', { ascending: false });

    if (!proposals || proposals.length === 0) continue;

    // 3. Generate "Daily Headline" using Gemini 2.5 Flash
    const model = genAI.getGenerativeModel({ model: AI_MODELS.summarization });
    const prompt = `
      You are Mila, an elite Executive Assistant.
      Review these ${proposals.length} pending actions for ${user.settings.address_name || 'the user'}.

      Actions: ${JSON.stringify(proposals)}

      Task: Generate a 1-2 sentence "Daily Headline" that summarizes the state of play.
      Then, list the top 3 items with their priority scores.
      Tone: ${user.settings.persona_tone || 'Professional'}
    `;

    const result = await model.generateContent(prompt);
    const briefContent = result.response.text();

    // 4. Send the Morning Brief Email
    await sendGmailMessage(user.id, user.google_oauth_tokens, {
      to: user.email,
      subject: `Mila: Your Morning Brief for ${new Date().toLocaleDateString()}`,
      body: briefContent
    });

    console.log(`[Cron] Brief sent to ${user.id} at 5:00 AM`);
  }

  return new Response('OK');
}
