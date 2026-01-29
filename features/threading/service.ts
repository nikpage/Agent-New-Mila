// features/threading/service.ts

import { createClient } from '@supabase/supabase-js';
import { generateEmbedding } from './embeddings';
import { ai, AI_CONFIG } from '../shared/ai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!
);

/**
 * Finds the correct conversation thread for a message based on vector similarity
 * or creates a new one.
 */
export async function threadMessage(
  userId: string,
  cpId: string,
  messageId: string,
  text: string
): Promise<string> {

  // 1. Generate Embedding
  const embedding = await generateEmbedding(text);
  if (!embedding) throw new Error("Failed to generate embedding");

  // 2. Store Embedding for the Message
  await supabase.from('message_embeddings').upsert({
    message_id: messageId,
    embedding: embedding
  });

  // 3. Search for Existing Conversation (Vector Search)
  // Assumes 'match_conversations' RPC exists in DB
  const { data: matches } = await supabase.rpc('match_conversations', {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.78,
    match_count: 5,
    target_user_id: userId
  });

  let threadId: string | null = null;

  // 4. Validate Match (Check if CP is a participant)
  if (matches && matches.length > 0) {
    for (const match of matches) {
      const { data: participant } = await supabase
        .from('thread_participants')
        .select('thread_id')
        .eq('thread_id', match.id)
        .eq('cp_id', cpId)
        .maybeSingle();

      if (participant) {
        threadId = match.id;
        break;
      }
    }
  }

  // 5. Create New Thread if No Match
  if (!threadId) {
    const { data: cp } = await supabase.from('cps').select('name').eq('id', cpId).single();
    const topic = cp?.name || 'New Contact';

    const { data: newThread, error } = await supabase
      .from('conversation_threads')
      .insert({
        user_id: userId,
        topic: topic,
        state: 'active',
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        embedding: embedding // Initial thread embedding
      })
      .select('id')
      .single();

    if (error) throw error;
    threadId = newThread.id;

    // Add Participant
    await supabase.from('thread_participants').insert({
      thread_id: threadId,
      cp_id: cpId,
      added_at: new Date().toISOString()
    });
  }

  // 6. Link Message to Thread
  await supabase
    .from('messages')
    .update({ conversation_id: threadId, thread_id: threadId })
    .eq('id', messageId);

  return threadId;
}

/**
 * Updates the AI summary of the conversation thread.
 */
export async function updateThreadSummary(threadId: string): Promise<void> {
  // 1. Fetch recent messages
  const { data: messages } = await supabase
    .from('messages')
    .select('cleaned_text, direction, timestamp')
    .eq('conversation_id', threadId)
    .order('timestamp', { ascending: false })
    .limit(10);

  if (!messages || messages.length === 0) return;

  // 2. Construct Prompt
  const transcript = messages.reverse().map(m =>
    `[${m.direction.toUpperCase()}]: ${m.cleaned_text}`
  ).join('\n');

  const prompt = `
    Summarize this email conversation thread.

    Conversation:
    ${transcript}

    Return a structured summary of the current state, potential risks, and concrete next steps.
  `;

  // 3. Call AI
  const response = await ai.models.generateContent({
    model: AI_CONFIG.models.smart, // Use smarter model for summarization
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: 'OBJECT',
        properties: {
          context: { type: 'STRING' },
          currentState: { type: 'STRING' },
          nextSteps: { type: 'ARRAY', items: { type: 'STRING' } },
          risks: { type: 'ARRAY', items: { type: 'STRING' } }
        }
      }
    }
  });

  if (response.text) {
    const summary = JSON.parse(response.text);

    // 4. Update DB
    await supabase
      .from('conversation_threads')
      .update({
        summary_json: summary,
        last_updated: new Date().toISOString()
      })
      .eq('id', threadId);
  }
}
