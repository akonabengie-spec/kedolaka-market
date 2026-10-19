ALTER TABLE products
  ADD COLUMN IF NOT EXISTS item_condition VARCHAR(20) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS price_unit VARCHAR(40) NOT NULL DEFAULT 'item',
  ADD COLUMN IF NOT EXISTS delivery_notes VARCHAR(500) NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname = 'products_item_condition_check'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_item_condition_check
      CHECK (item_condition IN ('new', 'used', 'refurbished'));
  END IF;
END;
$$;
