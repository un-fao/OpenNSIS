-- 035: sampling designs become publishable map layers.
-- Publish / Active follow the same semantics as rasters and soil profiles;
-- symbology styles the design's points on the public map; abstract is the
-- auto-generated, human-readable account of the whole design (method,
-- parameters, seed, sources with licences, quality) shown behind the
-- metadata icon. Idempotent.

ALTER TABLE api.sampling_design
  ADD COLUMN IF NOT EXISTS is_published  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS active_default boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS symbology     jsonb,
  ADD COLUMN IF NOT EXISTS abstract      text;
