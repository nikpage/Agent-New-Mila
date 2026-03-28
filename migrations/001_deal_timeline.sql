-- Migration: deal_timeline table
-- Part of: Unified Deal Timeline feature
-- Safe to run: additive only, no existing tables modified

CREATE TABLE deal_timeline (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cp_id uuid NOT NULL REFERENCES cps(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversation_threads(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES deal_timeline(id) ON DELETE SET NULL,
  event_type text NOT NULL,          -- 'email', 'whatsapp', 'call_log', 'voice_note'
  direction text NOT NULL,           -- 'in', 'out', 'internal'
  occurred_at timestamptz NOT NULL,  -- when it actually happened (sort key)
  ingested_at timestamptz NOT NULL DEFAULT now(),
  content text,                      -- cleaned text, note, or transcription
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  metadata jsonb DEFAULT '{}'::jsonb
);

-- Primary query: "all timeline events for a CP, sorted by when they happened"
CREATE INDEX idx_timeline_user_cp_occurred
  ON deal_timeline (user_id, cp_id, occurred_at DESC);

-- Conversation assignment writeback: find unassigned entries
CREATE INDEX idx_timeline_unassigned
  ON deal_timeline (user_id, cp_id)
  WHERE conversation_id IS NULL;

-- Parent lookup (voice notes → call logs)
CREATE INDEX idx_timeline_parent
  ON deal_timeline (parent_id)
  WHERE parent_id IS NOT NULL;

-- Message dedup: prevent double-inserting the same message
CREATE UNIQUE INDEX idx_timeline_message_id
  ON deal_timeline (message_id)
  WHERE message_id IS NOT NULL;

-- RLS policy
ALTER TABLE deal_timeline ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own timeline"
  ON deal_timeline FOR ALL
  USING (user_id = auth.uid());
