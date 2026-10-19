ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS payment_methods JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS checkout_group_key UUID;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_instructions TEXT;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_payment_method_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IN (
    'Sandbox', 'PostPNG_COD', 'PMV_Cash', 'sandbox_test_record',
    'manual_bank_transfer', 'mobile_wallet', 'cash_on_delivery', 'in_person'
  ));

CREATE INDEX IF NOT EXISTS idx_orders_buyer_checkout_group
  ON orders (buyer_id, checkout_group_key)
  WHERE checkout_group_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS vendor_payment_verifications (
  verification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  vendor_id BIGINT NOT NULL REFERENCES vendors(vendor_id) ON DELETE RESTRICT,
  verified_by BIGINT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL CHECK (status IN ('successful', 'failed')),
  receipt_reference VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_payment_verifications_order
  ON vendor_payment_verifications(order_id, created_at DESC);
