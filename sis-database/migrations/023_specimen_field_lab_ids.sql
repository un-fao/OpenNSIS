-- 023: chain-of-custody identifiers on specimens (SoilFER-LIMS integration).
--
-- Two identifiers travel with a physical sample:
--   sample_field_id — the ID written on the bag when the sample is collected in the
--              field (the LIMS's sampleId/originalId);
--   sample_lab_id   — the ID the laboratory assigns at reception (e.g.
--              LAB-2026-KE-001).
--
-- The old free-form `code` column was ambiguous between the two. No component
-- ever read or wrote it, so it is RENAMED to sample_field_id — non-destructive, in
-- case a national instance hand-loaded values into it. The rename is guarded
-- so the migration stays idempotent and also works on databases where `code`
-- never existed.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'soil_data' AND table_name = 'specimen'
                 AND column_name = 'code')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'soil_data' AND table_name = 'specimen'
                 AND column_name = 'sample_field_id') THEN
        ALTER TABLE soil_data.specimen RENAME COLUMN code TO sample_field_id;
    END IF;
END $$;

ALTER TABLE soil_data.specimen
  ADD COLUMN IF NOT EXISTS sample_field_id character varying;

ALTER TABLE soil_data.specimen
  ADD COLUMN IF NOT EXISTS sample_lab_id character varying;

COMMENT ON COLUMN soil_data.specimen.sample_field_id IS
  'Identifier given to the physical sample at field collection (chain of custody; LIMS sampleId).';
COMMENT ON COLUMN soil_data.specimen.sample_lab_id IS
  'Identifier assigned by the laboratory at sample reception (chain of custody; LIMS labId).';
