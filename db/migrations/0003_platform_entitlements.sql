BEGIN;
ALTER TABLE platform.user_profiles
  ADD COLUMN IF NOT EXISTS subscription_status TEXT
    CHECK (subscription_status IN ('free', 'active', 'trialing', 'past_due', 'canceling', 'canceled', 'expired', 'payment_failed')),
  ADD COLUMN IF NOT EXISTS access_until TIMESTAMPTZ;

-- Preserve explicit Premium accounts from before subscription lifecycle tracking.
UPDATE platform.user_profiles
SET subscription_status = CASE plan WHEN 'premium' THEN 'active' ELSE 'free' END
WHERE subscription_status IS NULL;
ALTER TABLE platform.user_profiles
  ALTER COLUMN subscription_status SET DEFAULT 'free',
  ALTER COLUMN subscription_status SET NOT NULL;
COMMIT;
