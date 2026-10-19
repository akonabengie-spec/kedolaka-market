ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipment_carrier VARCHAR(80),
  ADD COLUMN IF NOT EXISTS shipment_booking_reference VARCHAR(120),
  ADD COLUMN IF NOT EXISTS shipment_tracking_reference VARCHAR(120),
  ADD COLUMN IF NOT EXISTS shipment_tracking_url TEXT,
  ADD COLUMN IF NOT EXISTS shipment_notes VARCHAR(500),
  ADD COLUMN IF NOT EXISTS shipment_updated_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shipment_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS order_refunds (
  refund_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE RESTRICT,
  payment_id BIGINT NOT NULL REFERENCES payments(payment_id) ON DELETE RESTRICT,
  admin_user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  amount_kina NUMERIC(12,2) NOT NULL CHECK (amount_kina > 0),
  refund_method VARCHAR(30) NOT NULL CHECK (refund_method IN ('bank_transfer', 'mobile_wallet', 'cash', 'other')),
  reference VARCHAR(120),
  reason VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_order_created
  ON order_refunds(order_id, created_at DESC);
