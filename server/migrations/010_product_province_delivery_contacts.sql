ALTER TABLE products
  ADD COLUMN IF NOT EXISTS delivery_contacts JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS delivery_contact JSONB;
