ALTER TABLE vendors
  DROP CONSTRAINT IF EXISTS vendors_status_check;

ALTER TABLE vendors
  ADD CONSTRAINT vendors_status_check
  CHECK (status IN ('review', 'active', 'suspended', 'rejected'));
