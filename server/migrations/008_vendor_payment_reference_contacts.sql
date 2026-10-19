ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_reference_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS payment_reference_whatsapp VARCHAR(30);

UPDATE vendors v
   SET payment_methods = (
     SELECT jsonb_agg(
       CASE
         WHEN method->>'id' IN ('bank_transfer', 'mobile_wallet')
          AND COALESCE(method->>'referencePhone', '') = ''
          AND COALESCE(method->>'referenceWhatsapp', '') = ''
          AND LENGTH(u.phone_number) = 12
          AND SUBSTRING(u.phone_number FROM 1 FOR 5) IN ('+6757', '+6758')
          AND SUBSTRING(u.phone_number FROM 6) ~ '^[0-9]{7}$'
         THEN method || jsonb_build_object('referencePhone', u.phone_number)
         ELSE method
       END
     )
       FROM jsonb_array_elements(v.payment_methods) AS item(method)
   ), updated_at = NOW()
  FROM users u
 WHERE u.user_id = v.user_id
   AND jsonb_typeof(v.payment_methods) = 'array'
  AND LENGTH(u.phone_number) = 12
  AND SUBSTRING(u.phone_number FROM 1 FOR 5) IN ('+6757', '+6758')
  AND SUBSTRING(u.phone_number FROM 6) ~ '^[0-9]{7}$'
   AND EXISTS (
     SELECT 1
       FROM jsonb_array_elements(v.payment_methods) AS item(method)
      WHERE method->>'id' IN ('bank_transfer', 'mobile_wallet')
        AND COALESCE(method->>'referencePhone', '') = ''
        AND COALESCE(method->>'referenceWhatsapp', '') = ''
   );
