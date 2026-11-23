-- Platform-owned state. Auth session/password tables belong to the maintained auth adapter.
-- Idempotent for a fresh or previously initialized PostgreSQL database.
BEGIN;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS platform.user_profiles (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 256),
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium')),
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.workspaces (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 300),
  owner_user_id TEXT NOT NULL REFERENCES platform.user_profiles(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_personal_workspace_per_owner
  ON platform.workspaces(owner_user_id) WHERE kind = 'personal';

CREATE TABLE IF NOT EXISTS platform.workspace_members (
  workspace_id TEXT NOT NULL REFERENCES platform.workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform.user_profiles(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_by_user
  ON platform.workspace_members(user_id, workspace_id);

CREATE TABLE IF NOT EXISTS platform.credit_wallets (
  user_id TEXT PRIMARY KEY REFERENCES platform.user_profiles(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only history prevents the browser from deciding an available balance.
CREATE TABLE IF NOT EXISTS platform.credit_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform.credit_wallets(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('starter_grant', 'purchase', 'subscription', 'reserve',
                                    'capture', 'release', 'refund', 'adjustment')),
  amount BIGINT NOT NULL CHECK (amount <> 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_entries_by_user
  ON platform.credit_entries(user_id, id);

CREATE TABLE IF NOT EXISTS platform.account_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 256),
  event_type TEXT NOT NULL CHECK (event_type = 'account.created'),
  user_id TEXT NOT NULL REFERENCES platform.user_profiles(user_id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, user_id)
);

-- Internal-only. Call after a verified auth provider has created the user.
-- A single SQL transaction ensures atomic events, wallet and memberships.
CREATE OR REPLACE FUNCTION platform.provision_account_created(
  p_user_id TEXT, p_event_id TEXT, p_starter_credits BIGINT
) RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 256 OR
     p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 256 OR
     p_starter_credits IS NULL OR p_starter_credits < 0 OR p_starter_credits > 1000000
  THEN
    RAISE EXCEPTION 'invalid_account_event' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id, 424242));

  INSERT INTO platform.user_profiles(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO platform.account_events(event_id, event_type, user_id)
    VALUES (p_event_id, 'account.created', p_user_id) ON CONFLICT DO NOTHING;

  IF EXISTS (
    SELECT 1 FROM platform.account_events
     WHERE event_id = p_event_id AND (event_type <> 'account.created' OR user_id <> p_user_id)
  ) THEN
    RAISE EXCEPTION 'account_event_id_reused' USING ERRCODE = '23505';
  END IF;

  INSERT INTO platform.workspaces(id, owner_user_id, kind, name)
    VALUES ('personal:' || p_user_id, p_user_id, 'personal', 'My workspace')
    ON CONFLICT DO NOTHING;

  INSERT INTO platform.workspace_members(workspace_id, user_id, role)
    VALUES ('personal:' || p_user_id, p_user_id, 'owner')
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

  INSERT INTO platform.credit_wallets(user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

  IF p_starter_credits > 0 THEN
    INSERT INTO platform.credit_entries(user_id, kind, amount, idempotency_key)
      VALUES (p_user_id, 'starter_grant', p_starter_credits, 'signup:' || p_user_id)
      ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
END
$fn$;
COMMIT;
