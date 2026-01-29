// features/ingestion/commandExecutor.ts

import { createClient } from '@supabase/supabase-js';
import { sendGmailMessage } from '../shared/outbound';

export async function executeUserCommand(userId: string, command: any, userTokens: any) {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  if (command.command === 'DO_IT' && command.actionId) {
    // 1. Fetch the Proposal
    const { data: proposal } = await supabase
      .from('action_proposals')
      .select('*, conversation_threads(external_thread_id), cps(primary_identifier)')
      .eq('id', command.actionId)
      .single();

    if (!proposal || !proposal.draft_body_text) {
      console.error("No draft found for DO IT command");
      return;
    }

    // 2. Execute the Send via Gmail
    try {
      await sendGmailMessage(userId, userTokens, {
        to: proposal.cps.primary_identifier,
        subject: proposal.draft_subject || 'Follow up',
        body: proposal.draft_body_text,
        threadId: proposal.conversation_threads?.external_thread_id
      });

      // 3. Update Status to Completed
      await supabase
        .from('action_proposals')
        .update({ status: 'completed', handled_at: new Date().toISOString() })
        .eq('id', command.actionId);

      console.log(`[Command] Action ${command.actionId} sent successfully.`);
    } catch (err) {
      console.error("[Command] Failed to send email:", err);
    }
  }

  // Handle other commands (EDIT, BLACKLIST) similarly...
}
