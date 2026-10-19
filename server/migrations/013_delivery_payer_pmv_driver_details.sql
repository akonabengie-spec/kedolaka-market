ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_payer VARCHAR(10) NOT NULL DEFAULT 'buyer',
  ADD COLUMN IF NOT EXISTS shipment_driver_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS shipment_driver_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS shipment_vehicle_plate VARCHAR(20),
  ADD COLUMN IF NOT EXISTS shipment_vehicle_description VARCHAR(120);

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_shipping_payer_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_shipping_payer_check
  CHECK (shipping_payer IN ('buyer', 'vendor'));
