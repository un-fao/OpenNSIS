-- 034: Sampling design (SoilFER three-stage CSC) — designs and their features.
--
-- Covariates are fetched ephemerally at run time and discarded; what persists
-- is the design itself (PSUs, SSUs, points with ranked replacements) and its
-- manifest: every source with URL, licence, retrieval time, resolution,
-- resampling and window checksum, plus parameters, seed and quality metrics.
-- Idempotent.

CREATE TABLE IF NOT EXISTS api.sampling_design (
  design_id   serial PRIMARY KEY,
  name        text NOT NULL,
  params      jsonb NOT NULL,
  sources     jsonb NOT NULL,                 -- recipe frozen at creation
  status      text NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  step_log    text NOT NULL DEFAULT '',
  manifest    jsonb,
  quality     jsonb,
  error       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS api.sampling_design_feature (
  feature_id  serial PRIMARY KEY,
  design_id   integer NOT NULL REFERENCES api.sampling_design(design_id) ON DELETE CASCADE,
  kind        text NOT NULL,                  -- psu | ssu | point
  sample_id   text,                           -- stamped ID (points only)
  rank        smallint NOT NULL DEFAULT 0,    -- 0 = target, 1/2 = replacements
  geom        geometry(Geometry, 4326) NOT NULL,
  props       jsonb
);

CREATE INDEX IF NOT EXISTS sampling_design_feature_design_idx
  ON api.sampling_design_feature (design_id, kind);
