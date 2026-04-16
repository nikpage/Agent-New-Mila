-- AI Usage Log — per-stage per-run cost tracking
-- One row per AI stage per agent run

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL,
  run_at      timestamptz NOT NULL DEFAULT now(),
  stage       text NOT NULL,
  model       text NOT NULL,
  calls       integer NOT NULL DEFAULT 0,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd    numeric(10, 6) NOT NULL DEFAULT 0
);

-- Indexes for common queries
CREATE INDEX idx_ai_usage_log_user_run ON ai_usage_log (user_id, run_at DESC);
CREATE INDEX idx_ai_usage_log_run_id ON ai_usage_log (run_id);

-- RLS
ALTER TABLE ai_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own usage" ON ai_usage_log
  FOR SELECT USING (auth.uid() = user_id);
