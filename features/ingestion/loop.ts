// features/ingestion/loop.ts

import 'dotenv/config'; // Standard env loading
import { createClient } from '@supabase/supabase-js';
import { ingestRecentEmails } from './service';
import { ingestOutboundEmails } from './outbound';
import { resolveCounterparty } from '../counterparty/service';
import { classifyEmail } from '../classification/service';
import { threadMessage, updateThreadSummary } from '../threading/service';
import { planNextMove } from '../planning/service';
import { generateDraft } from '../drafting/service';
import { parseEmailCommand } from '../inbox/commandParser';
import { scheduleAction } from '../planning/scheduler';
import { IngestedEmail } from './types';

// Headless Agent Entry Point

async function runAgentLoop() {
  console.log('[\x1b[32mSTART\x1b[0m] Initializing Headless Agent Loop...');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('[\x1b[31mFATAL\x1b[0m] Missing SUPABASE_URL or SUPABASE_KEY in .env');
    (process as any).exit(1);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );

  // 1. Fetch User Context
  let userId = process.env.TEST_USER_ID || '8679c8eb-725e-48b3-930a-f35bbbf3b2c2';
  let user;

  const { data: specificUser, error: userError } = await supabase
      .from('users')
      .select('id, google_oauth_tokens')
      .eq('id', userId)
      .single();

  if (userError || !specificUser) {
    console.error(`[\x1b[31mERROR\x1b[0m] Targeted user ${userId} not found in DB.`);

    // Fallback: Try to find ANY valid user if the specific one fails
    console.log('[\x1b[33mWARN\x1b[0m] Attempting to auto-detect an alternative user...');
    const { data: firstUser } = await supabase
      .from('users')
      .select('id, google_oauth_tokens')
      .not('google_oauth_tokens', 'is', null)
      .limit(1)
      .maybeSingle();

    if (firstUser) {
      console.log(`[\x1b[33mNOTICE\x1b[0m] Switching to found user: ${firstUser.id}`);
      userId = firstUser.id;
      user = firstUser;
    } else {
      console.error('[\x1b[31mFATAL\x1b[0m] No usable users found. Exiting.');
      (process as any).exit(1);
    }
  } else {
    user = specificUser;
    console.log(`[\x1b[32mUSER\x1b[0m] Loaded context for: ${userId}`);
  }

  if (!user?.google_oauth_tokens) {
    console.error(`[\x1b[31mERROR\x1b[0m] User ${userId} has no Google tokens.`);
    (process as any).exit(1);
  }

  // 2. Ingestion Phase
  console.log('[\x1b[34mINGEST\x1b[0m] Polling Inbox...');
  let emails: IngestedEmail[] = [];
  try {
    emails = await ingestRecentEmails(userId, user.google_oauth_tokens);
  } catch (ingestError: any) {
    console.error(`[\x1b[31mINGEST FAIL\x1b[0m] ${ingestError.message}`);
  }

  console.log('[\x1b[34mINGEST\x1b[0m] Polling Outbound (Sent)...');
  let outboundEmails: IngestedEmail[] = [];
  try {
    outboundEmails = await ingestOutboundEmails(userId, user.google_oauth_tokens);
  } catch (outboundError: any) {
    console.error(`[\x1b[31mOUTBOUND FAIL\x1b[0m] ${outboundError.message}`);
  }

  const allEmails = [...emails, ...outboundEmails];

  if (allEmails.length === 0) {
    console.log('[\x1b[33mIDLE\x1b[0m] No new messages found.');
    return;
  }

  console.log(`[\x1b[32mFOUND\x1b[0m] ${emails.length} new inbound, ${outboundEmails.length} new outbound.`);

  // 3. Processing Loop
  for (const email of allEmails) {
    const isOutbound = outboundEmails.includes(email);
    console.log(`\n---------------------------------------------------`);
    console.log(`[\x1b[36mPROCESS\x1b[0m] Message: "${email.subject}"`);
    console.log(`           From: ${email.from} (${isOutbound ? 'OUTBOUND' : 'INBOUND'})`);

    try {
      // A. Identity
      let cpId: string;
      if (isOutbound) {
        const { data: msg } = await supabase.from('messages').select('cp_id').eq('external_id', email.id).single();
        if (!msg) throw new Error("Message record not found after ingestion");
        cpId = msg.cp_id;
      } else {
         cpId = await resolveCounterparty(userId, email.from);
      }
      console.log(`   └─ [\x1b[35mIDENTITY\x1b[0m] ID: ${cpId}`);

      // B. Command Parsing (Mila Port)
      const command = parseEmailCommand(email.bodyPlain);
      if (command.command) {
        console.log(`   └─ [\x1b[35mCOMMAND\x1b[0m] ${command.command} (ActionID: ${command.actionId || 'None'})`);

        // --- COMMAND EXECUTION LOGIC ---
        if (command.actionId) {
            // "DO IT" -> Approve the action/todo
            if (command.command === 'DO_IT') {
                const { error: updateError } = await supabase.from('todos')
                    .update({ status: 'approved', last_updated: new Date().toISOString() })
                    .eq('id', command.actionId);

                if (!updateError) console.log(`      \x1b[32m[EXEC]\x1b[0m Action ${command.actionId} APPROVED.`);
                else console.error(`      \x1b[31m[EXEC FAIL]\x1b[0m ${updateError.message}`);
            }
            // "I'LL DO IT" -> Mark completed manually
            else if (command.command === 'ILL_DO_IT') {
                const { error: updateError } = await supabase.from('todos')
                    .update({ status: 'completed', notes: 'Handled manually by user', last_updated: new Date().toISOString() })
                    .eq('id', command.actionId);

                 if (!updateError) console.log(`      \x1b[32m[EXEC]\x1b[0m Action ${command.actionId} marked MANUAL COMPLETE.`);
            }
            // "EDIT:" -> Request revision
            else if (command.command === 'EDIT') {
                 const { error: updateError } = await supabase.from('todos')
                    .update({
                        status: 'needs_revision',
                        notes: command.editNotes || 'User requested edit',
                        last_updated: new Date().toISOString()
                    })
                    .eq('id', command.actionId);

                if (!updateError) console.log(`      \x1b[32m[EXEC]\x1b[0m Action ${command.actionId} marked for REVISION.`);
            }
        }

        // "BLACKLIST CP" -> Block counterparty
        if (command.command === 'BLACKLIST_CP') {
             const { error: blockError } = await supabase.from('cps')
                .update({ is_blacklisted: true })
                .eq('id', cpId);

             if (!blockError) console.log(`      \x1b[31m[BLOCK]\x1b[0m Counterparty ${cpId} BLACKLISTED.`);
        }
        // -------------------------------
      }

      // C. Classification (Skip for outbound)
      let classification: any = { category: 'BUSINESS', actionRequired: false };
      if (!isOutbound) {
        classification = await classifyEmail(email);
        console.log(`   └─ [\x1b[35mCLASS\x1b[0m] ${classification.category} (Action: ${classification.actionRequired})`);
      }

      // D. Threading
      const { data: msgRecord } = await supabase
        .from('messages')
        .select('id')
        .eq('external_id', email.id)
        .single();

      if (msgRecord) {
        const threadId = await threadMessage(userId, cpId, msgRecord.id, email.bodyPlain);
        await updateThreadSummary(threadId);
        console.log(`   └─ [\x1b[35mTHREAD\x1b[0m] Context Updated (${threadId})`);

        // E. Planning (Only for Inbound)
        if (!isOutbound) {
            const plan = await planNextMove(threadId, email.bodyPlain);
            console.log(`   └─ [\x1b[32mPLAN\x1b[0m] Strategy: ${plan.action}`);
            console.log(`      Reasoning: ${plan.reasoning.substring(0, 100)}...`);
            console.log(`      Score: ${plan.scores.totalPriority} (Val:${plan.scores.dollar_value} Urg:${plan.scores.urgency} Ign:${plan.scores.days_ignored})`);

            // F. Scheduler Logic
            if (plan.action === 'SCHEDULE') {
              console.log(`   └─ [\x1b[33mSCHEDULER\x1b[0m] Checking calendar availability...`);
              await scheduleAction(
                userId,
                user.google_oauth_tokens,
                cpId,
                classification,
                email,
                threadId
              );
            }

            // G. Drafting
            if (['REPLY', 'SCHEDULE'].includes(plan.action)) {
              console.log(`   └─ [\x1b[33mDRAFT\x1b[0m] Generating content...`);

              const { data: thread } = await supabase
                  .from('conversation_threads')
                  .select('summary_json')
                  .eq('id', threadId)
                  .single();

              const draft = await generateDraft(email.from, plan, thread?.summary_json);
              console.log(`      Draft Subject: "${draft.subject}"`);
            }
        }
      }

    } catch (err: any) {
      console.error(`   └─ [\x1b[31mFAIL\x1b[0m] ${err.message}`);
    }
  }

  console.log(`\n---------------------------------------------------`);
  console.log('[\x1b[32mDONE\x1b[0m] Cycle complete.');
}

runAgentLoop().catch(console.error);
