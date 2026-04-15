-- Migration 003: Add 'deal_id' as a valid scope value for journal_entries.
-- Required by belief-log-updater (Chunk 6) which scopes observations to deals.

ALTER TABLE journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_scope_check;

ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_scope_check
  CHECK (scope IN ('global', 'cp_id', 'conversation_id', 'deal_id', 'temporal'));
