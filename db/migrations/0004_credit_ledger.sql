-- Atomic credit ledger, reservations and settlement.
-- Reserve/release rows are immutable audit events; settled balance excludes them.
BEGIN;

ALTER TABLE platform.credit_entries
  DROP CONSTRAINT IF EXISTS credit_entries_kind_check;
ALTER TABLE platform.credit_entries
  ADD CONSTRAINT credit_entries_kind_check CHECK (
    kind IN ('starter_grant', 'purchase', 'subscription', 'reserve', 'capture',
             'release', 'refund', 'adjustment', 'reversal', 'expiry')
  );

ALTER TABLE platform.credit_entries
  ADD COLUMN IF NOT EXISTS operation_key TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS tool TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS top_up_id TEXT;

-- Compatibility for account provisioning and any older trusted writer that only
-- supplies the existing idempotency key. BEFORE INSERT runs before NOT NULL checks.
CREATE OR REPLACE FUNCTION platform.credit_entry_fill_operation_key()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operation_key IS NULL THEN
    NEW.operation_key := NEW.idempotency_key;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS credit_entry_fill_operation_key ON platform.credit_entries;
CREATE TRIGGER credit_entry_fill_operation_key
  BEFORE INSERT ON platform.credit_entries
  FOR EACH ROW EXECUTE FUNCTION platform.credit_entry_fill_operation_key();

UPDATE platform.credit_entries
   SET operation_key = idempotency_key
 WHERE operation_key IS NULL;
ALTER TABLE platform.credit_entries
  ALTER COLUMN operation_key SET NOT NULL;

ALTER TABLE platform.credit_entries
  DROP CONSTRAINT IF EXISTS credit_entries_operation_key_length,
  DROP CONSTRAINT IF EXISTS credit_entries_reason_length,
  DROP CONSTRAINT IF EXISTS credit_entries_tool_length,
  DROP CONSTRAINT IF EXISTS credit_entries_model_length,
  DROP CONSTRAINT IF EXISTS credit_entries_job_id_length,
  DROP CONSTRAINT IF EXISTS credit_entries_top_up_id_length;
ALTER TABLE platform.credit_entries
  ADD CONSTRAINT credit_entries_operation_key_length
    CHECK (length(operation_key) BETWEEN 1 AND 300),
  ADD CONSTRAINT credit_entries_reason_length
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT credit_entries_tool_length
    CHECK (tool IS NULL OR length(tool) BETWEEN 1 AND 100),
  ADD CONSTRAINT credit_entries_model_length
    CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
  ADD CONSTRAINT credit_entries_job_id_length
    CHECK (job_id IS NULL OR length(job_id) BETWEEN 1 AND 256),
  ADD CONSTRAINT credit_entries_top_up_id_length
    CHECK (top_up_id IS NULL OR length(top_up_id) BETWEEN 1 AND 256);

CREATE INDEX IF NOT EXISTS credit_entries_by_user_operation
  ON platform.credit_entries(user_id, operation_key, id);
CREATE UNIQUE INDEX IF NOT EXISTS credit_entries_one_kind_per_operation
  ON platform.credit_entries(user_id, operation_key, kind);

CREATE TABLE IF NOT EXISTS platform.credit_reservations (
  user_id TEXT NOT NULL REFERENCES platform.credit_wallets(user_id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 200),
  max_amount BIGINT NOT NULL CHECK (max_amount > 0),
  captured_amount BIGINT CHECK (captured_amount IS NULL OR captured_amount >= 0),
  released_amount BIGINT CHECK (released_amount IS NULL OR released_amount >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled')),
  tool TEXT CHECK (tool IS NULL OR length(tool) BETWEEN 1 AND 100),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 200),
  job_id TEXT CHECK (job_id IS NULL OR length(job_id) BETWEEN 1 AND 256),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, operation_key),
  CHECK (
    (status = 'reserved' AND captured_amount IS NULL AND released_amount IS NULL AND settled_at IS NULL)
    OR
    (status = 'settled' AND captured_amount IS NOT NULL AND released_amount IS NOT NULL
      AND captured_amount + released_amount = max_amount AND settled_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS credit_reservations_active_by_user
  ON platform.credit_reservations(user_id, created_at)
  WHERE status = 'reserved';

CREATE OR REPLACE FUNCTION platform.credit_meter(p_user_id TEXT)
RETURNS TABLE (
  settled_balance BIGINT,
  reserved BIGINT,
  available BIGINT,
  spent BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH ledger AS (
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE kind NOT IN ('reserve', 'release')), 0)::bigint AS balance,
      COALESCE(-SUM(amount) FILTER (WHERE kind = 'capture' AND amount < 0), 0)::bigint AS spent
    FROM platform.credit_entries
    WHERE user_id = p_user_id
  ), holds AS (
    SELECT COALESCE(SUM(max_amount), 0)::bigint AS reserved
    FROM platform.credit_reservations
    WHERE user_id = p_user_id AND status = 'reserved'
  )
  SELECT ledger.balance, holds.reserved, ledger.balance - holds.reserved, ledger.spent
  FROM ledger CROSS JOIN holds
$$;
REVOKE ALL ON FUNCTION platform.credit_meter(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.reserve_credits(
  p_user_id TEXT,
  p_operation_key TEXT,
  p_max_amount BIGINT,
  p_tool TEXT DEFAULT NULL,
  p_model TEXT DEFAULT NULL,
  p_job_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  operation_key TEXT,
  max_amount BIGINT,
  status TEXT,
  available BIGINT,
  reserved BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_existing platform.credit_reservations%ROWTYPE;
  v_meter RECORD;
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 256 OR
     p_operation_key IS NULL OR p_operation_key <> btrim(p_operation_key) OR
     length(p_operation_key) NOT BETWEEN 1 AND 200 OR
     p_max_amount IS NULL OR p_max_amount <= 0 OR p_max_amount > 1000000000000 OR
     (p_tool IS NOT NULL AND (p_tool <> btrim(p_tool) OR length(p_tool) NOT BETWEEN 1 AND 100)) OR
     (p_model IS NOT NULL AND (p_model <> btrim(p_model) OR length(p_model) NOT BETWEEN 1 AND 200)) OR
     (p_job_id IS NOT NULL AND (p_job_id <> btrim(p_job_id) OR length(p_job_id) NOT BETWEEN 1 AND 256))
  THEN
    RAISE EXCEPTION 'invalid_credit_reservation' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM platform.credit_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_wallet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
  FROM platform.credit_reservations AS r
  WHERE r.user_id = p_user_id AND r.operation_key = p_operation_key;

  IF FOUND THEN
    IF v_existing.max_amount <> p_max_amount OR
       v_existing.tool IS DISTINCT FROM p_tool OR
       v_existing.model IS DISTINCT FROM p_model OR
       v_existing.job_id IS DISTINCT FROM p_job_id
    THEN
      RAISE EXCEPTION 'credit_operation_reused' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
    RETURN QUERY SELECT v_existing.operation_key, v_existing.max_amount, v_existing.status,
                        v_meter.available, v_meter.reserved;
    RETURN;
  END IF;

  SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
  IF v_meter.available < p_max_amount THEN
    RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO platform.credit_reservations(user_id, operation_key, max_amount, tool, model, job_id)
  VALUES (p_user_id, p_operation_key, p_max_amount, p_tool, p_model, p_job_id);

  INSERT INTO platform.credit_entries(
    user_id, kind, amount, idempotency_key, operation_key, tool, model, job_id
  ) VALUES (
    p_user_id, 'reserve', p_max_amount,
    'credit-reserve:' || md5(p_user_id || ':' || p_operation_key),
    p_operation_key, p_tool, p_model, p_job_id
  );

  SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
  RETURN QUERY SELECT p_operation_key, p_max_amount, 'reserved'::text,
                      v_meter.available, v_meter.reserved;
END
$$;
REVOKE ALL ON FUNCTION platform.reserve_credits(TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.settle_credit_reservation(
  p_user_id TEXT,
  p_operation_key TEXT,
  p_actual_amount BIGINT,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  operation_key TEXT,
  captured BIGINT,
  released BIGINT,
  available BIGINT,
  reserved BIGINT,
  spent BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_reservation platform.credit_reservations%ROWTYPE;
  v_release BIGINT;
  v_meter RECORD;
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 256 OR
     p_operation_key IS NULL OR p_operation_key <> btrim(p_operation_key) OR
     length(p_operation_key) NOT BETWEEN 1 AND 200 OR
     p_actual_amount IS NULL OR p_actual_amount < 0 OR p_actual_amount > 1000000000000 OR
     (p_reason IS NOT NULL AND (p_reason <> btrim(p_reason) OR length(p_reason) NOT BETWEEN 1 AND 500))
  THEN
    RAISE EXCEPTION 'invalid_credit_settlement' USING ERRCODE = '22023';
  END IF;
  IF p_actual_amount = 0 AND p_reason IS NULL THEN
    RAISE EXCEPTION 'credit_failure_reason_required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM platform.credit_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_wallet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_reservation
  FROM platform.credit_reservations AS r
  WHERE r.user_id = p_user_id AND r.operation_key = p_operation_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_actual_amount > v_reservation.max_amount THEN
    RAISE EXCEPTION 'credit_capture_exceeds_reservation' USING ERRCODE = '22023';
  END IF;

  IF v_reservation.status = 'settled' THEN
    IF v_reservation.captured_amount <> p_actual_amount OR
       v_reservation.reason IS DISTINCT FROM p_reason
    THEN
      RAISE EXCEPTION 'credit_settlement_reused' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
    RETURN QUERY SELECT v_reservation.operation_key, v_reservation.captured_amount,
                        v_reservation.released_amount, v_meter.available,
                        v_meter.reserved, v_meter.spent;
    RETURN;
  END IF;

  v_release := v_reservation.max_amount - p_actual_amount;

  IF p_actual_amount > 0 THEN
    INSERT INTO platform.credit_entries(
      user_id, kind, amount, idempotency_key, operation_key, reason, tool, model, job_id
    ) VALUES (
      p_user_id, 'capture', -p_actual_amount,
      'credit-capture:' || md5(p_user_id || ':' || p_operation_key),
      p_operation_key, p_reason, v_reservation.tool, v_reservation.model, v_reservation.job_id
    );
  END IF;

  IF v_release > 0 THEN
    INSERT INTO platform.credit_entries(
      user_id, kind, amount, idempotency_key, operation_key, reason, tool, model, job_id
    ) VALUES (
      p_user_id, 'release', v_release,
      'credit-release:' || md5(p_user_id || ':' || p_operation_key),
      p_operation_key, p_reason, v_reservation.tool, v_reservation.model, v_reservation.job_id
    );
  END IF;

  UPDATE platform.credit_reservations AS r
     SET captured_amount = p_actual_amount,
         released_amount = v_release,
         status = 'settled',
         reason = p_reason,
         settled_at = now()
   WHERE r.user_id = p_user_id AND r.operation_key = p_operation_key;

  SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
  RETURN QUERY SELECT p_operation_key, p_actual_amount, v_release,
                      v_meter.available, v_meter.reserved, v_meter.spent;
END
$$;
REVOKE ALL ON FUNCTION platform.settle_credit_reservation(TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.apply_credit_entry(
  p_user_id TEXT,
  p_operation_key TEXT,
  p_kind TEXT,
  p_amount BIGINT,
  p_reason TEXT DEFAULT NULL,
  p_tool TEXT DEFAULT NULL,
  p_model TEXT DEFAULT NULL,
  p_job_id TEXT DEFAULT NULL,
  p_top_up_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  entry_id BIGINT,
  kind TEXT,
  amount BIGINT,
  available BIGINT,
  reserved BIGINT,
  spent BIGINT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_existing platform.credit_entries%ROWTYPE;
  v_meter RECORD;
  v_id BIGINT;
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 256 OR
     p_operation_key IS NULL OR p_operation_key <> btrim(p_operation_key) OR
     length(p_operation_key) NOT BETWEEN 1 AND 200 OR
     p_kind NOT IN ('purchase', 'subscription', 'refund', 'adjustment', 'reversal', 'expiry') OR
     p_amount IS NULL OR p_amount = 0 OR p_amount < -1000000000000 OR p_amount > 1000000000000 OR
     (p_reason IS NOT NULL AND (p_reason <> btrim(p_reason) OR length(p_reason) NOT BETWEEN 1 AND 500)) OR
     (p_tool IS NOT NULL AND (p_tool <> btrim(p_tool) OR length(p_tool) NOT BETWEEN 1 AND 100)) OR
     (p_model IS NOT NULL AND (p_model <> btrim(p_model) OR length(p_model) NOT BETWEEN 1 AND 200)) OR
     (p_job_id IS NOT NULL AND (p_job_id <> btrim(p_job_id) OR length(p_job_id) NOT BETWEEN 1 AND 256)) OR
     (p_top_up_id IS NOT NULL AND (p_top_up_id <> btrim(p_top_up_id) OR length(p_top_up_id) NOT BETWEEN 1 AND 256))
  THEN
    RAISE EXCEPTION 'invalid_credit_entry' USING ERRCODE = '22023';
  END IF;

  IF (p_kind IN ('purchase', 'subscription', 'refund', 'reversal') AND p_amount <= 0) OR
     (p_kind = 'expiry' AND p_amount >= 0) OR
     (p_kind IN ('refund', 'adjustment', 'reversal', 'expiry') AND p_reason IS NULL)
  THEN
    RAISE EXCEPTION 'invalid_credit_entry_semantics' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM platform.credit_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_wallet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
  FROM platform.credit_entries AS e
  WHERE e.user_id = p_user_id AND e.operation_key = p_operation_key AND e.kind = p_kind;

  IF FOUND THEN
    IF v_existing.amount <> p_amount OR
       v_existing.reason IS DISTINCT FROM p_reason OR
       v_existing.tool IS DISTINCT FROM p_tool OR
       v_existing.model IS DISTINCT FROM p_model OR
       v_existing.job_id IS DISTINCT FROM p_job_id OR
       v_existing.top_up_id IS DISTINCT FROM p_top_up_id
    THEN
      RAISE EXCEPTION 'credit_operation_reused' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
    RETURN QUERY SELECT v_existing.id, v_existing.kind, v_existing.amount,
                        v_meter.available, v_meter.reserved, v_meter.spent;
    RETURN;
  END IF;

  SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
  IF p_amount < 0 AND v_meter.available + p_amount < 0 THEN
    RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO platform.credit_entries(
    user_id, kind, amount, idempotency_key, operation_key, reason, tool, model, job_id, top_up_id
  ) VALUES (
    p_user_id, p_kind, p_amount,
    'credit-entry:' || md5(p_user_id || ':' || p_kind || ':' || p_operation_key),
    p_operation_key, p_reason, p_tool, p_model, p_job_id, p_top_up_id
  ) RETURNING id INTO v_id;

  SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
  RETURN QUERY SELECT v_id, p_kind, p_amount,
                      v_meter.available, v_meter.reserved, v_meter.spent;
END
$$;
REVOKE ALL ON FUNCTION platform.apply_credit_entry(TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

COMMIT;
