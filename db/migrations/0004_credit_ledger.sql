-- Atomic credit reservations and settlement.
-- Reserve/release entries are audit events; only grants/debits/refunds/adjustments affect settled balance.
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

UPDATE platform.credit_entries
   SET operation_key = idempotency_key
 WHERE operation_key IS NULL;
ALTER TABLE platform.credit_entries
  ALTER COLUMN operation_key SET NOT NULL;
ALTER TABLE platform.credit_entries
  ADD CONSTRAINT credit_entries_operation_key_length
    CHECK (length(operation_key) BETWEEN 1 AND 200) NOT VALID;
ALTER TABLE platform.credit_entries
  VALIDATE CONSTRAINT credit_entries_operation_key_length;
CREATE INDEX IF NOT EXISTS credit_entries_by_user_operation
  ON platform.credit_entries(user_id, operation_key, id);

CREATE TABLE IF NOT EXISTS platform.credit_reservations (
  user_id TEXT NOT NULL REFERENCES platform.credit_wallets(user_id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 200),
  max_amount BIGINT NOT NULL CHECK (max_amount > 0),
  captured_amount BIGINT CHECK (captured_amount IS NULL OR captured_amount >= 0),
  released_amount BIGINT CHECK (released_amount IS NULL OR released_amount >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled')),
  tool TEXT,
  model TEXT,
  job_id TEXT,
  reason TEXT,
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
     p_max_amount IS NULL OR p_max_amount <= 0 OR p_max_amount > 1000000000000
  THEN
    RAISE EXCEPTION 'invalid_credit_reservation' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM platform.credit_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_wallet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
  FROM platform.credit_reservations
  WHERE user_id = p_user_id AND credit_reservations.operation_key = p_operation_key;

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
    'reserve:' || md5(p_user_id || ':' || p_operation_key),
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
     p_actual_amount IS NULL OR p_actual_amount < 0
  THEN
    RAISE EXCEPTION 'invalid_credit_settlement' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM platform.credit_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_wallet_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_reservation
  FROM platform.credit_reservations
  WHERE user_id = p_user_id AND credit_reservations.operation_key = p_operation_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_reservation_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_actual_amount > v_reservation.max_amount THEN
    RAISE EXCEPTION 'credit_capture_exceeds_reservation' USING ERRCODE = '22023';
  END IF;

  IF v_reservation.status = 'settled' THEN
    IF v_reservation.captured_amount <> p_actual_amount THEN
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
      'capture:' || md5(p_user_id || ':' || p_operation_key),
      p_operation_key, p_reason, v_reservation.tool, v_reservation.model, v_reservation.job_id
    );
  END IF;

  IF v_release > 0 THEN
    INSERT INTO platform.credit_entries(
      user_id, kind, amount, idempotency_key, operation_key, reason, tool, model, job_id
    ) VALUES (
      p_user_id, 'release', v_release,
      'release:' || md5(p_user_id || ':' || p_operation_key),
      p_operation_key, p_reason, v_reservation.tool, v_reservation.model, v_reservation.job_id
    );
  END IF;

  UPDATE platform.credit_reservations
     SET captured_amount = p_actual_amount,
         released_amount = v_release,
         status = 'settled',
         reason = p_reason,
         settled_at = now()
   WHERE user_id = p_user_id AND credit_reservations.operation_key = p_operation_key;

  SELECT * INTO v_meter FROM platform.credit_meter(p_user_id);
  RETURN QUERY SELECT p_operation_key, p_actual_amount, v_release,
                      v_meter.available, v_meter.reserved, v_meter.spent;
END
$$;
REVOKE ALL ON FUNCTION platform.settle_credit_reservation(TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC;

COMMIT;
