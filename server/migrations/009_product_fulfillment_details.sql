ALTER TABLE products
  ADD COLUMN IF NOT EXISTS additional_details JSONB NOT NULL DEFAULT '{}'::jsonb;
