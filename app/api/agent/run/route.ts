// app/api/agent/run/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Feature Imports
import { ingestRecentEmails } from '../../../../features/ingestion/service';
import { classifyEmail } from '../../../../features/classification/service';
import { resolveCounterparty } from '../../../../features/counterparty/service';
import { threadMessage, updateThreadSummary } from '../../../../features/threading/service';
import { planNextMove } from '../../../../features/planning/service';
import { generateDraft } from '../../../../features/drafting/service';

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const body = await req.json();
    const userId = body.userId;

    if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 });

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    );

    // 1. Get User Tokens
    const { data: user } = await supabase
      .from('users')
      .select('google_oauth_tokens')
      .eq('id', userId)
      .single();

    if (!user?.google_oauth_tokens) {
      return NextResponse.json({ error: 'User has no connected Google Account' }, { status: 400 });
    }

    // 2. INGEST
    const newEmails = await ingestRecentEmails(userId, user.google_oauth_tokens);
    const results = [];

    // Process Loop
    for (const email of newEmails) {
      console.log(`[Agent] Processing ${email.id}...`);

      // 3. RESOLVE IDENTITY
      const cpId = await resolveCounterparty(userId, email.from);

      // 4. CLASSIFY
      const classification = await classifyEmail(email);

      // 5. THREAD
      // We need the internal message ID
      const { data: msgRecord } = await supabase
        .from('messages')
        .select('id')
        .eq('external_id', email.id)
        .single();

      if (!msgRecord) continue;

      const threadId = await threadMessage(userId, cpId, msgRecord.id, email.bodyPlain);
      await updateThreadSummary(threadId);

      // 6. PLAN
      const plan = await planNextMove(threadId, email.bodyPlain);

      // 7. EXECUTE (Drafting)
      let draft = null;
      if (['REPLY', 'SCHEDULE'].includes(plan.action)) {
        // Fetch fresh summary for drafting
        const { data: thread } = await supabase
          .from('conversation_threads')
          .select('summary_json')
          .eq('id', threadId)
          .single();

        draft = await generateDraft(email.from, plan, thread?.summary_json);
      }

      // 8. STORE PROPOSAL
      if (plan.action !== 'FILE' && plan.action !== 'WAIT') {
        await supabase.from('action_proposals').insert({
          user_id: userId,
          conversation_id: threadId,
          cp_id: cpId,
          action_type: plan.action,
          priority_score: plan.scores.totalPriority,
          status: 'pending', // Waiting for user approval
          rationale: plan.reasoning,
          draft_subject: draft?.subject,
          draft_body_text: draft?.body,
          dollar_value: plan.scores.dollar_value,
          pain_factor: plan.scores.pain_factor,
          weight: plan.scores.weight,
          urgency: plan.scores.urgency,
          offer_multiplier: plan.scores.offer_multiplier,
          payload: {
            plan_details: plan,
            classification: classification
          }
        });
      }

      // Final Tag Update
      // Mapped to 'tag_primary' as per schema (removed ai_summary/status)
      await supabase
        .from('messages')
        .update({
          tag_primary: classification.category
        })
        .eq('id', msgRecord.id);

      results.push({
        emailId: email.id,
        action: plan.action,
        priority: plan.scores.totalPriority
      });
    }

    return NextResponse.json({
      success: true,
      processed: newEmails.length,
      results
    });

  } catch (error: any) {
    console.error('Agent Run Failed:', error);
    return NextResponse.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
