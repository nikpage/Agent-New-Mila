// features/counterparty/service.ts

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!
);

export async function resolveCounterparty(userId: string, fromHeader: string): Promise<string> {
    // Extract email from "Name <email@domain.com>" or just "email@domain.com"
    const match = fromHeader.match(/<(.+?)>/);
    const email = match ? match[1].toLowerCase() : fromHeader.toLowerCase().trim();

    // Check DB for existing counterparty
    const { data: existing } = await supabase.from('cps')
        .select('id')
        .eq('primary_identifier', email)
        .maybeSingle();

    if (existing) return existing.id;

    // Create new counterparty if not found
    const name = fromHeader.replace(/<.*>/, '').trim() || email.split('@')[0];

    const { data: newCp, error } = await supabase.from('cps').insert({
        user_id: userId,
        primary_identifier: email,
        name: name,

    }).select('id').single();

    if (error) {
        // Handle race condition if created concurrently
        const { data: retry } = await supabase.from('cps')
            .select('id')
            .eq('primary_identifier', email)
            .single();
        if (retry) return retry.id;
        throw error;
    }

    return newCp!.id;
}
