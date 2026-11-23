#!/usr/bin/env bash
set -euo pipefail
if [[ -z "$DATABASE_URL" ]]; then echo "DATABASE_URL is required" >&2; exit 1; fi

psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0001_platform_accounts.sql
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
SELECT platform.provision_account_created('alice', 'evt-1', 25);
SELECT platform.provision_account_created('alice', 'evt-1', 999);
SELECT platform.provision_account_created('alice', 'evt-2', 999);
SELECT platform.provision_account_created('bob', 'evt-3', 30);
DO $$
BEGIN
  IF (SELECT count(*) FROM platform.user_profiles) <> 2 THEN RAISE EXCEPTION 'profiles duplicated'; END IF;
  IF (SELECT count(*) FROM platform.workspaces) <> 2 THEN RAISE EXCEPTION 'workspaces duplicated'; END IF;
  IF (SELECT count(*) FROM platform.workspace_members) <> 2 THEN RAISE EXCEPTION 'memberships duplicated'; END IF;
  IF (SELECT count(*) FROM platform.credit_wallets) <> 2 THEN RAISE EXCEPTION 'wallets duplicated'; END IF;
  IF (SELECT count(*) FROM platform.credit_entries) <> 2 THEN RAISE EXCEPTION 'grants duplicated'; END IF;
  IF (SELECT amount FROM platform.credit_entries WHERE user_id = 'alice') <> 25 THEN RAISE EXCEPTION 'regrant'; END IF;
  IF (SELECT count(*) FROM platform.account_events) <> 2 THEN RAISE EXCEPTION 'events duplicated'; END IF;
END $$;
SQL
# Existing-fixture migration must be safe to repeat.
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0001_platform_accounts.sql
for i in 1 2 3 4 5; do
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "SELECT platform.provision_account_created('charlie', 'evt-charlie-$i', 500);" >/dev/null &
done
wait
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM platform.credit_entries WHERE user_id = 'charlie') <> 1 THEN RAISE EXCEPTION 'duplicate concurrent grant'; END IF;
  IF (SELECT amount FROM platform.credit_entries WHERE user_id = 'charlie') <> 500 THEN RAISE EXCEPTION 'wrong concurrent grant amount'; END IF;
  IF (SELECT count(*) FROM platform.workspaces WHERE owner_user_id = 'charlie' AND kind = 'personal') <> 1 THEN RAISE EXCEPTION 'duplicate personal workspace'; END IF;
END $$;
SQL
if psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "SELECT platform.provision_account_created('mallory', 'evt-1', 99);" >/dev/null 2>&1; then
  echo "Expected event-ID collision to fail" >&2
  exit 1
fi
echo "PostgreSQL account foundation checks passed"
