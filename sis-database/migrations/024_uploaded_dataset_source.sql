-- 024: record where a staged dataset came from.
--
-- 'csv'      — file upload (the default; legacy data, where the laboratory
--              reception ID is usually lost — sample_lab_id stays optional);
-- 'lims-api' — fetched from a laboratory API (e.g. SoilFER-LIMS), where the
--              lab ID always exists at the source, so validation makes the
--              'Lab sample ID' mapping compulsory and every row must carry
--              a value.

ALTER TABLE api.uploaded_dataset
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'csv';

COMMENT ON COLUMN api.uploaded_dataset.source IS
  'Origin of the staged data: csv (file upload; lab ID optional) or lims-api (laboratory API; sample_lab_id compulsory).';
