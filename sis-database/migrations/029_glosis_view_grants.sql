-- 029: restore the sis_glosis read grants on the federation data views.
--
-- The read-only sis_glosis role is supposed to SELECT exactly three views
-- (manifest, profile, observation). At some point the views were dropped and
-- recreated, which silently discards grants (CREATE OR REPLACE keeps them,
-- DROP + CREATE does not) — so every GloSIS data endpoint answered 500
-- "permission denied" fleet-wide while token verification (api.setting +
-- the token view, whose grants survived) kept working. Idempotent.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sis_glosis') THEN
    GRANT SELECT ON api.vw_api_manifest,
                    api.vw_api_profile,
                    api.vw_api_observation
      TO sis_glosis;
  END IF;
END
$$;
