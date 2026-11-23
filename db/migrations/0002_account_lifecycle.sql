-- Run after Better Auth has created its "user" table, on the same database role/search path.
BEGIN;
CREATE OR REPLACE FUNCTION platform.sync_auth_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.id, 424242));
    -- Keep only the opaque ID for downstream private-object cleanup.
    INSERT INTO platform.account_deletions(user_id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
    DELETE FROM platform.user_profiles WHERE user_id = OLD.id;
    RETURN OLD;
  END IF;
  PERFORM platform.provision_account_created(
    NEW.id, 'auth-user:' || NEW.id, current_setting('platform.starter_credits')::bigint
  );
  IF NOT EXISTS (SELECT 1 FROM platform.user_profiles WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'retired_account_identity';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.sync_auth_lifecycle() FROM PUBLIC;

CREATE OR REPLACE TRIGGER platform_account_lifecycle AFTER INSERT OR DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION platform.sync_auth_lifecycle();

-- Repair an older signup whose post-commit callback never completed. Existing
-- events keep their original allocation, including a zero-credit signup.
SELECT platform.provision_account_created(u.id, 'auth-user:' || u.id,
                                         current_setting('platform.starter_credits')::bigint)
  FROM "user" AS u
 WHERE NOT EXISTS (SELECT 1 FROM platform.account_events e WHERE e.user_id = u.id);
COMMIT;
