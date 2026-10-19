ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_payment_status_check,
  DROP CONSTRAINT IF EXISTS orders_payment_method_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_payment_status_check
    CHECK (payment_status IN ('pending', 'successful', 'failed', 'refunded', 'cancelled', 'expired')),
  ADD CONSTRAINT orders_payment_method_check
    CHECK (payment_method IN (
      'Sandbox', 'PostPNG_COD', 'PMV_Cash', 'sandbox_test_record',
      'manual_bank_transfer', 'cash_on_delivery', 'in_person'
    ));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_status_check,
  DROP CONSTRAINT IF EXISTS payments_mode_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
    CHECK (status IN ('pending', 'successful', 'failed', 'refunded', 'cancelled', 'expired')),
  ADD CONSTRAINT payments_mode_check
    CHECK (mode IN ('sandbox', 'live', 'manual')),
  ADD COLUMN IF NOT EXISTS provider_reference VARCHAR(120),
  ADD COLUMN IF NOT EXISTS verified_by BIGINT REFERENCES users(user_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_reference
  ON payments(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_expiry
  ON payments(expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_reservations (
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'consumed', 'released', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active_product
  ON inventory_reservations(product_id, expires_at)
  WHERE status = 'reserved';
