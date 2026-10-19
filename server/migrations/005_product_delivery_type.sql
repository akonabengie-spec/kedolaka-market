ALTER TABLE products
  ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) NOT NULL DEFAULT 'both';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname = 'products_delivery_type_check'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_delivery_type_check
      CHECK (delivery_type IN ('delivery', 'pickup', 'both'));
  END IF;
END;
$$;
