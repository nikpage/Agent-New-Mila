-- Migration: Deals schema — new tables + FK columns
-- Chunk 2 of refactor plan (docs/Refacrot plan.md)
-- Safe to run: all new columns are nullable; existing data untouched

-- ─── New tables ─────────────────────────────────────────────────────────────

CREATE TABLE deals (
  id                  uuid          DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               text          NOT NULL,
  category            text          NOT NULL DEFAULT 'business', -- 'business', 'personal', 'admin', 'service'
  user_role           text          NOT NULL DEFAULT 'representing_seller', -- 'representing_seller', 'representing_buyer', 'both', 'personal', 'admin'
  deal_type           text,                                                  -- sale/purchase/rental/lease/consultation/other
  status              text          NOT NULL DEFAULT 'active',  -- 'active', 'archived', 'closed', 'merged'
  parent_deal_id      uuid          REFERENCES deals(id) ON DELETE SET NULL,
  potential_merge_with uuid         REFERENCES deals(id) ON DELETE SET NULL,
  anomaly_boost       float         NOT NULL DEFAULT 0,
  last_activity_at    timestamptz,
  last_processed_at   timestamptz,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_deals_user_status   ON deals (user_id, status);
CREATE INDEX idx_deals_last_activity ON deals (user_id, last_activity_at DESC);

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access their own deals"
  ON deals FOR ALL USING (user_id = auth.uid());


CREATE TABLE deal_participants (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id     uuid        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  cp_id       uuid        NOT NULL REFERENCES cps(id)  ON DELETE CASCADE,
  role        text,
  status      text        NOT NULL DEFAULT 'active',   -- 'active', 'dropped', 'merged'
  added_at    timestamptz NOT NULL DEFAULT now(),
  dropped_at  timestamptz
);

CREATE INDEX idx_deal_participants_deal ON deal_participants (deal_id);
CREATE INDEX idx_deal_participants_cp   ON deal_participants (cp_id, status);
-- A CP can participate in many deals, but only once per deal (per role)
CREATE UNIQUE INDEX idx_deal_participants_unique ON deal_participants (deal_id, cp_id, role)
  WHERE status = 'active';


CREATE TABLE entity_map (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  deal_id           uuid        NOT NULL REFERENCES deals(id)    ON DELETE CASCADE,
  entity_type       text        NOT NULL, -- 'price', 'address', 'deadline', 'document_state', 'commitment', 'contact_info', 'meeting_venue', 'deal_stage'
  entity_key        text        NOT NULL, -- unique within deal+type, e.g. "asking_price"
  entity_value      text        NOT NULL,
  source_message_id uuid        REFERENCES messages(id) ON DELETE SET NULL,
  confidence        float       NOT NULL DEFAULT 1.0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id, entity_type, entity_key)
);

CREATE INDEX idx_entity_map_deal ON entity_map (deal_id, entity_type);

ALTER TABLE entity_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access their own entity map"
  ON entity_map FOR ALL USING (user_id = auth.uid());


CREATE TABLE deal_graph_nodes (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id       uuid        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cp_id         uuid        REFERENCES cps(id) ON DELETE SET NULL, -- buyer-specific branches
  label         text        NOT NULL,
  node_type     text        NOT NULL, -- 'milestone', 'document', 'action', 'deadline', 'external'
  status        text        NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'blocked', 'skipped'
  completed_at  timestamptz,
  deadline      timestamptz,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_graph_nodes_deal   ON deal_graph_nodes (deal_id, status);
CREATE INDEX idx_graph_nodes_cp     ON deal_graph_nodes (cp_id) WHERE cp_id IS NOT NULL;

ALTER TABLE deal_graph_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access their own graph nodes"
  ON deal_graph_nodes FOR ALL USING (user_id = auth.uid());


CREATE TABLE deal_graph_edges (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id      uuid        NOT NULL REFERENCES deals(id)            ON DELETE CASCADE,
  from_node_id uuid        NOT NULL REFERENCES deal_graph_nodes(id) ON DELETE CASCADE,
  to_node_id   uuid        NOT NULL REFERENCES deal_graph_nodes(id) ON DELETE CASCADE,
  edge_type    text        NOT NULL DEFAULT 'depends_on', -- 'depends_on', 'blocks', 'suggests'
  source       text        NOT NULL DEFAULT 'system',    -- 'system', 'ai'
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_graph_edges_deal     ON deal_graph_edges (deal_id);
CREATE INDEX idx_graph_edges_from     ON deal_graph_edges (from_node_id);
CREATE INDEX idx_graph_edges_to       ON deal_graph_edges (to_node_id);
CREATE UNIQUE INDEX idx_graph_edges_unique ON deal_graph_edges (from_node_id, to_node_id, edge_type);


CREATE TABLE extraction_results (
  id                 uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id            uuid        NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  deal_id            uuid        NOT NULL REFERENCES deals(id)  ON DELETE CASCADE,
  scratchpad         text,
  hard_facts         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  soft_observations  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_extraction_results_deal ON extraction_results (deal_id, created_at DESC);

ALTER TABLE extraction_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can only access their own extraction results"
  ON extraction_results FOR ALL USING (user_id = auth.uid());


-- ─── FK columns on existing tables ──────────────────────────────────────────

ALTER TABLE conversation_threads
  ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE SET NULL;

CREATE INDEX idx_conversation_threads_deal ON conversation_threads (deal_id)
  WHERE deal_id IS NOT NULL;


ALTER TABLE deal_timeline
  ADD COLUMN deal_id       uuid    REFERENCES deals(id) ON DELETE SET NULL,
  ADD COLUMN temporal_data jsonb,
  ADD COLUMN is_emergency  boolean NOT NULL DEFAULT false;

CREATE INDEX idx_timeline_deal ON deal_timeline (deal_id)
  WHERE deal_id IS NOT NULL;

CREATE INDEX idx_timeline_emergency ON deal_timeline (user_id, is_emergency)
  WHERE is_emergency = true;


ALTER TABLE action_proposals
  ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE SET NULL;

CREATE INDEX idx_action_proposals_deal ON action_proposals (deal_id)
  WHERE deal_id IS NOT NULL;


ALTER TABLE journal_entries
  ADD COLUMN deal_id uuid REFERENCES deals(id) ON DELETE SET NULL;

CREATE INDEX idx_journal_entries_deal ON journal_entries (deal_id)
  WHERE deal_id IS NOT NULL;


-- ─── Deferred drops — run at Chunk 10 cutover ───────────────────────────────
-- These columns/tables are still read by existing code.
-- Remove the comments and run AFTER Chunk 10 cleanup is deployed.

-- DROP TABLE IF EXISTS message_embeddings;
-- ALTER TABLE conversation_threads DROP COLUMN IF EXISTS embedding;
-- ALTER TABLE conversation_threads DROP COLUMN IF EXISTS priority_score;
-- ALTER TABLE conversation_threads DROP COLUMN IF EXISTS messages_since_rebuild;
-- ALTER TABLE messages              DROP COLUMN IF EXISTS enriched_text;  -- deprecated, dual-write until Chunk 10
