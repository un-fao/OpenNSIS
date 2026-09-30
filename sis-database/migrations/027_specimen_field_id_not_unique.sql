-- 027: sample_field_id is an identifier, not a global uniqueness domain.
--
-- The pre-rename specimen.code column carried a UNIQUE constraint
-- (specimen_code_key), which migration 023's rename silently kept. A
-- laboratory-API import is a full snapshot, so the same physical
-- specimens reappear on every fetch — and once ingested anywhere, the
-- constraint blocked any later ingest of the same samples DB-wide.
-- Bag codes also cannot be assumed unique across projects/laboratories.

ALTER TABLE soil_data.specimen
  DROP CONSTRAINT IF EXISTS specimen_code_key;
