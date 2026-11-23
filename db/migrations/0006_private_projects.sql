BEGIN;

CREATE TABLE IF NOT EXISTS platform.projects (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  document jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(document) = 'object'),
  script text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Free deadline. The live owner's subscription determines whether it applies.
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_by_workspace ON platform.projects(workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS projects_by_expiry ON platform.projects(expires_at, id);

CREATE TABLE IF NOT EXISTS platform.project_assets (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES platform.projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  backend text NOT NULL CHECK (backend IN ('local','s3')),
  filename text NOT NULL,
  media_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('script','media','subtitle','thumbnail','brand','render')),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  job_id text CHECK (length(job_id) BETWEEN 1 AND 256),
  ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_by_project ON platform.project_assets(project_id, created_at);
CREATE INDEX IF NOT EXISTS pending_project_uploads ON platform.project_assets(created_at) WHERE NOT ready;

-- An object is named only by its unique asset ID. Deletion work must survive
-- project, workspace and auth-user cascades, and remember the original backend.
CREATE TABLE IF NOT EXISTS platform.project_object_deletions (
  asset_id uuid PRIMARY KEY, owner_id text NOT NULL, backend text NOT NULL,
  retry_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS project_object_retries ON platform.project_object_deletions(retry_at, asset_id);
CREATE INDEX IF NOT EXISTS project_object_deletions_by_owner ON platform.project_object_deletions(owner_id);
CREATE OR REPLACE FUNCTION platform.queue_project_object_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform.project_object_deletions(asset_id, owner_id, backend)
    VALUES (OLD.id, OLD.owner_id, OLD.backend) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE OR REPLACE TRIGGER queue_project_object_delete AFTER DELETE ON platform.project_assets
  FOR EACH ROW EXECUTE FUNCTION platform.queue_project_object_delete();

ALTER TABLE platform.account_deletions ADD COLUMN IF NOT EXISTS projects_cleaned_at timestamptz;
-- Live wallets and account events close with the profile. Retain their accounting
-- records under the opaque account ID, separate from scripts and private files.
CREATE TABLE IF NOT EXISTS platform.retired_account_audit (
  owner_id text NOT NULL, source text NOT NULL, record_id text NOT NULL,
  record jsonb NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source, record_id)
);
CREATE OR REPLACE FUNCTION platform.retain_retired_account_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot jsonb := to_jsonb(OLD);
BEGIN
  IF EXISTS (SELECT 1 FROM platform.account_deletions WHERE user_id=OLD.user_id) THEN
    INSERT INTO platform.retired_account_audit(owner_id, source, record_id, record)
      VALUES (OLD.user_id, TG_TABLE_NAME, snapshot ->> TG_ARGV[0], snapshot) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;
CREATE OR REPLACE TRIGGER retain_retired_credits AFTER DELETE ON platform.credit_entries
  FOR EACH ROW EXECUTE FUNCTION platform.retain_retired_account_record('id');
CREATE OR REPLACE TRIGGER retain_retired_account_events AFTER DELETE ON platform.account_events
  FOR EACH ROW EXECUTE FUNCTION platform.retain_retired_account_record('event_id');
COMMIT;
