BEGIN;
CREATE TABLE IF NOT EXISTS platform.caption_documents (
  id UUID PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES platform.user_profiles(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project','preset')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  style JSONB NOT NULL CHECK (jsonb_typeof(style) = 'object'),
  words JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'preset' AND words IS NULL) OR
         (kind = 'project' AND words IS NOT NULL AND jsonb_typeof(words) = 'array'))
);
CREATE INDEX IF NOT EXISTS caption_documents_by_owner
  ON platform.caption_documents(owner_user_id, updated_at DESC, id);
COMMIT;
