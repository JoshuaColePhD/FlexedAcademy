"""Additive chat continuity schema; existing chat RLS protects these columns."""

SCHEMA_SQL = """
ALTER TABLE chats ADD COLUMN IF NOT EXISTS sources_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS planning_state_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS parent_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS branch_message_id BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS plan_revision BIGINT;
CREATE TABLE IF NOT EXISTS chat_metrics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('chat','plan','revision','voice')),
  channel TEXT NOT NULL CHECK(channel IN ('typed','voice')),
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','action_requested','saved','failed','cancelled','interrupted')),
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  first_response_ms INTEGER,
  stt_ms INTEGER,
  llm_ms INTEGER,
  speech_ms INTEGER,
  client_reported BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_metrics_created ON chat_metrics(created_at);
ALTER TABLE chat_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_metrics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_metrics_owner ON chat_metrics;
CREATE POLICY chat_metrics_owner ON chat_metrics
  USING (user_id = current_setting('app.user_id', true) OR current_setting('app.support_admin', true) = '1')
  WITH CHECK (user_id = current_setting('app.user_id', true));
DO $$ DECLARE app_role TEXT;
BEGIN
  FOR app_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON TABLE chat_metrics FROM %I', app_role);
  END LOOP;
END $$;
"""
