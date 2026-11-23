#!/usr/bin/env bash
set -euo pipefail
if [[ -z "$DATABASE_URL" ]]; then echo "DATABASE_URL is required" >&2; exit 1; fi

psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0001_platform_accounts.sql
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
SELECT platform.provision_account_created('alice', 'evt-1', 25);
SELECT platform.provision_account_created('alice', 'evt-1', 999);
SELECT platform.provision_account_created('alice', 'evt-2', 999);
SELECT platform.provision_account_created('bob', 'evt-3', 30);
SELECT platform.provision_account_created('zero', 'evt-zero', 0);
SELECT platform.provision_account_created('zero', 'evt-zero-retry', 999);
DO $$
BEGIN
  IF (SELECT count(*) FROM platform.user_profiles) <> 3 THEN RAISE EXCEPTION 'profiles duplicated'; END IF;
  IF (SELECT count(*) FROM platform.workspaces) <> 3 THEN RAISE EXCEPTION 'workspaces duplicated'; END IF;
  IF (SELECT count(*) FROM platform.workspace_members) <> 3 THEN RAISE EXCEPTION 'memberships duplicated'; END IF;
  IF (SELECT count(*) FROM platform.credit_wallets) <> 3 THEN RAISE EXCEPTION 'wallets duplicated'; END IF;
  IF (SELECT count(*) FROM platform.credit_entries) <> 2 THEN RAISE EXCEPTION 'grants duplicated'; END IF;
  IF (SELECT amount FROM platform.credit_entries WHERE user_id = 'alice') <> 25 THEN RAISE EXCEPTION 'regrant'; END IF;
  IF (SELECT count(*) FROM platform.account_events) <> 3 THEN RAISE EXCEPTION 'events duplicated'; END IF;
  IF (SELECT count(*) FROM platform.credit_entries WHERE user_id = 'zero') <> 0 THEN RAISE EXCEPTION 'zero-credit account regranted'; END IF;
END $$;
SQL
# Existing-fixture migration must be safe to repeat.
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0001_platform_accounts.sql
pids=()
for i in 1 2 3 4 5; do
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "SELECT platform.provision_account_created('charlie', 'evt-charlie-$i', 500);" >/dev/null &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
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

# A pre-lifecycle Premium account keeps access on upgrade. Replays preserve later billing updates.
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "UPDATE platform.user_profiles SET plan = 'premium' WHERE user_id = 'alice'"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0003_platform_entitlements.sql
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
DO $$
BEGIN
  IF (SELECT subscription_status FROM platform.user_profiles WHERE user_id = 'alice') IS DISTINCT FROM 'active'
    OR (SELECT subscription_status FROM platform.user_profiles WHERE user_id = 'bob') IS DISTINCT FROM 'free'
  THEN RAISE EXCEPTION 'incorrect subscription backfill'; END IF;
END $$;
UPDATE platform.user_profiles SET subscription_status='canceling', access_until='2030-01-01T00:00:00Z' WHERE user_id='alice';
SQL
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0003_platform_entitlements.sql
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.user_profiles WHERE user_id='alice' AND subscription_status='canceling'
                 AND access_until='2030-01-01T00:00:00Z') THEN RAISE EXCEPTION 'migration overwrote cancellation'; END IF;
END $$;
SQL

# Credit reservations are a separate migration layered on the account wallet.
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f db/migrations/0004_credit_ledger.sql
node --test tests/platformCredits.pg.mjs
