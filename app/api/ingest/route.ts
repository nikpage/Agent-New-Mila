import { createClient } from '@supabase/supabase-js';
import { genAI } from '../../../../features/shared/ai';
import { fetchRecentEmails } from '../../../../features/shared/gmail'; // Ensure this path is correct

export async function POST(req: Request) {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data: users } = await supabase.from('users').select('*');

  if (!users) return new Response('No users', { status: 200 });

  for (const user of users) {
    // 1. Get the actual emails
    const emails = await fetchRecentEmails(user.id, user.google_oauth_tokens);

    for (const email of emails) {
      // 2. Use Gemini to see if this email needs an action
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const prompt = `Analyze this email and create a 1-sentence action item.
                      Subject: ${email.subject}
                      Body: ${email.body}`;

      const result = await model.generateContent(prompt);
      const actionContent = result.response.text();

      // 3. INSERT into the table the Cron job reads
      await supabase.from('action_proposals').insert({
        user_id: user.id,
        content: actionContent,
        status: 'pending', // This is the key for the Cron job
        metadata: {
          from: email.from,
          subject: email.subject
        }
      });
    }
  }

  return new Response('Ingestion Complete');
}
