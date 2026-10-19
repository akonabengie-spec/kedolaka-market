ALTER TABLE freight_rates
  DROP CONSTRAINT IF EXISTS freight_rates_provider_check;

ALTER TABLE freight_rates
  ADD CONSTRAINT freight_rates_provider_check
  CHECK (provider IN ('PMV', 'PostPNG', 'Ship', 'AirNiugini', 'Pickup'));

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_shipping_provider_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_shipping_provider_check
  CHECK (shipping_provider IN ('PMV', 'PostPNG', 'Ship', 'AirNiugini', 'Pickup'));
