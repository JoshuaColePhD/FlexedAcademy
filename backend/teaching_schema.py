"""Append-only teaching workflow schema, applied by the application migrator."""

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS plan_versions (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan_json JSONB NOT NULL,
  retrieved_ids JSONB NOT NULL DEFAULT '[]',
  warnings JSONB NOT NULL DEFAULT '[]',
  provenance JSONB NOT NULL DEFAULT '{}',
  template_id TEXT,
  template TEXT,
  unit TEXT,
  week_number INTEGER,
  PRIMARY KEY (plan_id, revision)
);
CREATE INDEX IF NOT EXISTS plan_versions_owner ON plan_versions(user_id, plan_id, revision DESC);
CREATE OR REPLACE FUNCTION snapshot_plan_version() RETURNS trigger AS $$
BEGIN
  INSERT INTO plan_versions(plan_id, revision, user_id, plan_json, retrieved_ids, warnings, provenance, template_id, template, unit, week_number)
  VALUES (NEW.id, NEW.revision, NEW.user_id, NEW.plan_json::jsonb,
    COALESCE(NEW.retrieved_ids::jsonb, '[]'), COALESCE(NEW.warnings::jsonb, '[]'),
    COALESCE(NEW.provenance, '{}'), NEW.template_id, NEW.template, NEW.unit, NEW.week_number)
  ON CONFLICT (plan_id, revision) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS plans_version_snapshot ON plans;
CREATE TRIGGER plans_version_snapshot AFTER INSERT OR UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION snapshot_plan_version();
INSERT INTO plan_versions(plan_id, revision, user_id, plan_json, retrieved_ids, warnings, provenance, template_id, template, unit, week_number)
SELECT id, revision, user_id, plan_json::jsonb, COALESCE(retrieved_ids::jsonb, '[]'),
  COALESCE(warnings::jsonb, '[]'), COALESCE(provenance, '{}'), template_id, template, unit, week_number FROM plans
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS lesson_delivery (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_index INTEGER NOT NULL CHECK (day_index BETWEEN 0 AND 13),
  plan_revision BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','taught','assessed','skipped')),
  notes TEXT NOT NULL DEFAULT '',
  review_checks JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(plan_id, day_index)
);
ALTER TABLE plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_versions_owner ON plan_versions;
CREATE POLICY plan_versions_owner ON plan_versions
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
ALTER TABLE lesson_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lesson_delivery_owner ON lesson_delivery;
CREATE POLICY lesson_delivery_owner ON lesson_delivery
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
ALTER TABLE curriculum_maps ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE curriculum_maps ADD COLUMN IF NOT EXISTS processing_error TEXT;
ALTER TABLE curriculum_maps ADD COLUMN IF NOT EXISTS chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE curriculum_maps ADD COLUMN IF NOT EXISTS week_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS material_ingest_jobs (
  map_id TEXT PRIMARY KEY REFERENCES curriculum_maps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS material_ingest_available ON material_ingest_jobs(status,available_at);
ALTER TABLE material_ingest_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS material_ingest_owner ON material_ingest_jobs;
CREATE POLICY material_ingest_owner ON material_ingest_jobs
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
DO $$ DECLARE app_role TEXT;
BEGIN
  FOR app_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON TABLE material_ingest_jobs FROM %I', app_role);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION queue_material_ingest() RETURNS trigger AS $$
BEGIN
  INSERT INTO material_ingest_jobs(map_id,user_id) VALUES (NEW.id,NEW.user_id)
    ON CONFLICT DO NOTHING;
  UPDATE curriculum_maps SET processing_status='queued' WHERE id=NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS curriculum_material_ingest ON curriculum_maps;
CREATE TRIGGER curriculum_material_ingest AFTER INSERT ON curriculum_maps
  FOR EACH ROW EXECUTE FUNCTION queue_material_ingest();
"""
