BEGIN;

CREATE TABLE IF NOT EXISTS platform.project_folders (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES platform.project_folders(workspace_id, id),
  CHECK (id IS DISTINCT FROM parent_id)
);
CREATE INDEX IF NOT EXISTS folder_children ON platform.project_folders(workspace_id, parent_id);
ALTER TABLE platform.projects ADD COLUMN IF NOT EXISTS folder_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform.projects'::regclass AND conname='projects_folder_scope') THEN
    ALTER TABLE platform.projects ADD CONSTRAINT projects_folder_scope FOREIGN KEY (workspace_id,folder_id)
      REFERENCES platform.project_folders(workspace_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS platform.project_versions (
  project_id uuid NOT NULL REFERENCES platform.projects(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  name text NOT NULL, script text NOT NULL, document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,revision)
);
-- The public asset UUID stays stable inside project JSON and snapshots. A download
-- still needs an active link in the requested project and current workspace access.
CREATE TABLE IF NOT EXISTS platform.project_asset_links (
  project_id uuid NOT NULL REFERENCES platform.projects(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES platform.project_assets(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id,asset_id)
);
CREATE INDEX IF NOT EXISTS active_project_links_by_asset ON platform.project_asset_links(asset_id);
CREATE TABLE IF NOT EXISTS platform.project_version_assets (
  project_id uuid NOT NULL, revision integer NOT NULL,
  asset_id uuid NOT NULL REFERENCES platform.project_assets(id),
  FOREIGN KEY(project_id,revision) REFERENCES platform.project_versions(project_id,revision) ON DELETE CASCADE,
  PRIMARY KEY(project_id,revision,asset_id)
);
CREATE INDEX IF NOT EXISTS version_links_by_asset ON platform.project_version_assets(asset_id);
CREATE INDEX IF NOT EXISTS private_objects_by_owner ON platform.project_assets(owner_id);

-- Run this conversion once. Replaying it must never resurrect a removed live link.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform.project_assets'::regclass AND conname='project_assets_project_id_fkey') THEN
    INSERT INTO platform.project_asset_links(project_id,asset_id) SELECT project_id,id FROM platform.project_assets ON CONFLICT DO NOTHING;
    ALTER TABLE platform.project_assets DROP CONSTRAINT project_assets_project_id_fkey;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION platform.link_original_project_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform.project_asset_links(project_id,asset_id) VALUES(NEW.project_id,NEW.id);
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER link_original_project_asset AFTER INSERT ON platform.project_assets
  FOR EACH ROW EXECUTE FUNCTION platform.link_original_project_asset();

-- The original project ID remains as provenance. Only the last live or historical
-- reference releases the object to the durable deletion queue from migration 0006.
CREATE OR REPLACE FUNCTION platform.release_unreferenced_project_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM platform.project_assets a WHERE a.id=OLD.asset_id
    AND NOT EXISTS(SELECT 1 FROM platform.project_asset_links WHERE asset_id=a.id)
    AND NOT EXISTS(SELECT 1 FROM platform.project_version_assets WHERE asset_id=a.id);
  RETURN OLD;
END $$;
CREATE OR REPLACE TRIGGER release_live_asset AFTER DELETE ON platform.project_asset_links
  FOR EACH ROW EXECUTE FUNCTION platform.release_unreferenced_project_asset();
CREATE OR REPLACE TRIGGER release_version_asset AFTER DELETE ON platform.project_version_assets
  FOR EACH ROW EXECUTE FUNCTION platform.release_unreferenced_project_asset();

CREATE TABLE IF NOT EXISTS platform.workspace_invitations (
  id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  email text NOT NULL, role text NOT NULL CHECK (role IN ('editor','viewer')),
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  UNIQUE(workspace_id,email)
);
COMMIT;
