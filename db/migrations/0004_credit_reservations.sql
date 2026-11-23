BEGIN;

CREATE TABLE IF NOT EXISTS platform.credit_reservations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform.credit_wallets(user_id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 256 AND operation_key = btrim(operation_key)),
  estimate BIGINT NOT NULL CHECK (estimate > 0),
  captured BIGINT CHECK (captured BETWEEN 0 AND estimate),
  settlement_reason TEXT CHECK (length(settlement_reason) BETWEEN 1 AND 256 AND settlement_reason = btrim(settlement_reason)),
  UNIQUE (user_id, operation_key)
);

ALTER TABLE platform.credit_entries
  ADD COLUMN IF NOT EXISTS reservation_id BIGINT REFERENCES platform.credit_reservations(id);

-- Historical entries continue to post their signed amount. For new reservations,
-- only the capture posts a debit. An open estimate reduces the spendable balance.
CREATE OR REPLACE VIEW platform.credit_usage AS
SELECT w.user_id,
       COALESCE(ledger.balance, 0) - COALESCE(holds.reserved, 0) AS available,
       COALESCE(holds.reserved, 0) AS reserved,
       COALESCE(ledger.spent, 0) AS spent
FROM platform.credit_wallets w
LEFT JOIN (
  SELECT user_id, SUM(amount) FILTER (WHERE reservation_id IS NULL OR kind = 'capture') AS balance,
         -SUM(amount) FILTER (WHERE kind = 'capture') AS spent
  FROM platform.credit_entries GROUP BY user_id
) ledger USING (user_id)
LEFT JOIN (
  SELECT user_id, SUM(estimate) AS reserved FROM platform.credit_reservations
  WHERE captured IS NULL GROUP BY user_id
) holds USING (user_id);

-- Called by trusted job code with its server-derived owner and maximum cost.
CREATE OR REPLACE FUNCTION platform.reserve_credits(p_user_id TEXT, p_operation_key TEXT, p_estimate BIGINT)
RETURNS platform.credit_reservations LANGUAGE plpgsql AS $$
DECLARE
  hold platform.credit_reservations;
BEGIN
  IF p_operation_key IS NULL OR length(p_operation_key) NOT BETWEEN 1 AND 256 OR p_operation_key <> btrim(p_operation_key)
     OR p_estimate IS NULL OR p_estimate <= 0 THEN
    RAISE EXCEPTION 'invalid_credit_reservation' USING ERRCODE = '22023';
  END IF;

  -- Lock before checking for replays or reading the balance. Competing jobs for
  -- this wallet see the preceding transaction's committed entries and open holds.
  PERFORM 1 FROM platform.credit_wallets WHERE user_id = p_user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_wallet_not_found'; END IF;
  SELECT * INTO hold FROM platform.credit_reservations WHERE user_id = p_user_id AND operation_key = p_operation_key;
  IF FOUND THEN
    IF hold.estimate <> p_estimate THEN RAISE EXCEPTION 'credit_operation_conflict'; END IF;
    RETURN hold;
  END IF;
  IF (SELECT available FROM platform.credit_usage WHERE user_id = p_user_id) < p_estimate THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  INSERT INTO platform.credit_reservations(user_id, operation_key, estimate)
    VALUES (p_user_id, p_operation_key, p_estimate) RETURNING * INTO hold;
  INSERT INTO platform.credit_entries(user_id, reservation_id, kind, amount, idempotency_key)
    VALUES (p_user_id, hold.id, 'reserve', -p_estimate, 'reserve:' || hold.id);
  RETURN hold;
END $$;

CREATE OR REPLACE FUNCTION platform.settle_credits(p_user_id TEXT, p_operation_key TEXT, p_actual BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS platform.credit_reservations LANGUAGE plpgsql AS $$
DECLARE
  hold platform.credit_reservations;
BEGIN
  PERFORM 1 FROM platform.credit_wallets WHERE user_id = p_user_id FOR NO KEY UPDATE;
  SELECT * INTO hold FROM platform.credit_reservations WHERE user_id = p_user_id AND operation_key = p_operation_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_reservation_not_found'; END IF;
  IF p_actual IS NULL OR p_actual NOT BETWEEN 0 AND hold.estimate OR (p_actual = 0 AND p_reason IS NULL)
     OR (p_reason IS NOT NULL AND (length(p_reason) NOT BETWEEN 1 AND 256 OR p_reason <> btrim(p_reason))) THEN
    RAISE EXCEPTION 'invalid_credit_settlement' USING ERRCODE = '22023';
  END IF;
  IF hold.captured IS NOT NULL THEN
    IF hold.captured <> p_actual OR hold.settlement_reason IS DISTINCT FROM p_reason THEN
      RAISE EXCEPTION 'credit_operation_conflict';
    END IF;
    RETURN hold;
  END IF;

  UPDATE platform.credit_reservations SET captured = p_actual, settlement_reason = p_reason
    WHERE id = hold.id RETURNING * INTO hold;
  IF p_actual > 0 THEN
    INSERT INTO platform.credit_entries(user_id, reservation_id, kind, amount, idempotency_key)
      VALUES (p_user_id, hold.id, 'capture', -p_actual, 'capture:' || hold.id);
  END IF;
  IF p_actual < hold.estimate THEN
    INSERT INTO platform.credit_entries(user_id, reservation_id, kind, amount, idempotency_key)
      VALUES (p_user_id, hold.id, 'release', hold.estimate - p_actual, 'release:' || hold.id);
  END IF;
  RETURN hold;
END $$;

REVOKE ALL ON FUNCTION platform.reserve_credits(TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.settle_credits(TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC;
COMMIT;
