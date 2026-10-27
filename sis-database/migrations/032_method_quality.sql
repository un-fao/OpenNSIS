-- 032: per-procedure measurement quality + censored results.
--
-- Uncertainty, limit of detection and limit of quantification are
-- characteristics of the analytical PROCEDURE (established in method
-- validation), so they live on soil_data.observation_num — the catalogue row
-- per (property, procedure, unit) that already carries value_min/value_max.
-- All values are in the row's unit_of_measure_id, except a relative
-- uncertainty (uncertainty_is_relative = true), which is a percentage.
--
-- Results below detection are stored as censored rows: value NULL and
-- censored = '<LOD'. The existing bounds trigger passes NULL values
-- unchanged, so only the NOT NULL constraint has to move into a CHECK.
--
-- api.uploaded_dataset_column gains method_* columns so the LIMS connector
-- can stage the laboratory's declared quality with each fetched dataset;
-- ingest copies it onto observation_num (converted to the canonical unit).
-- Idempotent.

ALTER TABLE soil_data.observation_num
  ADD COLUMN IF NOT EXISTS uncertainty real,
  ADD COLUMN IF NOT EXISTS uncertainty_is_relative boolean,
  ADD COLUMN IF NOT EXISTS coverage_factor real,
  ADD COLUMN IF NOT EXISTS limit_of_detection real,
  ADD COLUMN IF NOT EXISTS limit_of_quantification real;

COMMENT ON COLUMN soil_data.observation_num.uncertainty IS
  'Measurement uncertainty of the procedure, in unit_of_measure_id (or % when uncertainty_is_relative).';
COMMENT ON COLUMN soil_data.observation_num.uncertainty_is_relative IS
  'True when uncertainty is a percentage of the value rather than absolute.';
COMMENT ON COLUMN soil_data.observation_num.coverage_factor IS
  'Coverage factor k when the uncertainty is expanded (k = 2 is the usual laboratory convention).';
COMMENT ON COLUMN soil_data.observation_num.limit_of_detection IS
  'Limit of detection of the procedure, in unit_of_measure_id.';
COMMENT ON COLUMN soil_data.observation_num.limit_of_quantification IS
  'Limit of quantification of the procedure, in unit_of_measure_id.';

ALTER TABLE soil_data.result_num
  ADD COLUMN IF NOT EXISTS censored text;
ALTER TABLE soil_data.result_num
  ALTER COLUMN value DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'result_num_value_or_censored') THEN
    ALTER TABLE soil_data.result_num
      ADD CONSTRAINT result_num_value_or_censored
      CHECK (value IS NOT NULL OR censored IS NOT NULL);
  END IF;
END $$;
COMMENT ON COLUMN soil_data.result_num.censored IS
  'Censoring marker for results without a numeric value, e.g. ''<LOD'' for below-detection.';

ALTER TABLE api.uploaded_dataset_column
  ADD COLUMN IF NOT EXISTS method_uncertainty real,
  ADD COLUMN IF NOT EXISTS method_uncertainty_is_relative boolean,
  ADD COLUMN IF NOT EXISTS method_coverage_factor real,
  ADD COLUMN IF NOT EXISTS method_lod real,
  ADD COLUMN IF NOT EXISTS method_loq real;

-- Expose the quality attributes and the censoring marker through the GloSIS
-- observation view. CREATE OR REPLACE (new columns appended at the end)
-- keeps the sis_glosis grants from migration 029 intact.
CREATE OR REPLACE VIEW api.vw_api_observation AS
 WITH ranked AS (
         SELECT p3.profile_id,
            p3.profile_code,
            proj.project_id,
            pl.is_published,
            pm.profile_limit,
            pm.locations_only,
            row_number() OVER (PARTITION BY proj.country_id, proj.project_id ORDER BY p3.profile_id) AS rn
           FROM soil_data.project proj
             LEFT JOIN soil_data.mapset pm ON pm.mapset_id = ((proj.country_id || '-'::text) || proj.project_id)
             LEFT JOIN soil_data.layer pl ON pl.layer_id = ((proj.country_id || '-'::text) || proj.project_id)
             LEFT JOIN soil_data.project_site sp ON sp.country_id = proj.country_id AND sp.project_id = proj.project_id
             LEFT JOIN soil_data.site s ON s.site_id = sp.site_id
             LEFT JOIN soil_data.plot p2 ON p2.site_id = s.site_id
             LEFT JOIN soil_data.profile p3 ON p3.plot_id = p2.plot_id
          WHERE p3.profile_id IS NOT NULL
        ), published AS (
         SELECT ranked.profile_id,
            ranked.profile_code
           FROM ranked
          WHERE ranked.is_published = true AND (ranked.profile_limit IS NULL OR ranked.rn <= ranked.profile_limit) AND ranked.locations_only IS NOT TRUE
        )
 SELECT pp.profile_code,
    e.upper_depth,
    e.lower_depth,
    o.property_num_id,
    o.procedure_num_id,
    r.value,
    o.unit_of_measure_id,
    r.censored,
    o.uncertainty,
    o.uncertainty_is_relative,
    o.coverage_factor,
    o.limit_of_detection,
    o.limit_of_quantification
   FROM published pp
     LEFT JOIN soil_data.element e ON e.profile_id = pp.profile_id
     LEFT JOIN soil_data.specimen s2 ON s2.element_id = e.element_id
     LEFT JOIN soil_data.result_num r ON r.specimen_id = s2.specimen_id
     LEFT JOIN soil_data.observation_num o ON o.observation_num_id = r.observation_num_id
  ORDER BY pp.profile_code, e.upper_depth, o.property_num_id;
