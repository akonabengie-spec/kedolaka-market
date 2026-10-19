ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS checkout_fingerprint CHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_buyer_idempotency
  ON orders (buyer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  audit_log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
  ON admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_resource
  ON admin_audit_logs (resource_type, resource_id, created_at DESC);
