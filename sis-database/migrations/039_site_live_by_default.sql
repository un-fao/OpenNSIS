-- ============================================================================
-- 039_site_live_by_default.sql
--
-- The public website is live by default. Instances that never pressed
-- Publish kept the landing hidden (SITE_LANDING_ENABLED seeded 'false' by
-- 033); flip that stored default so the default website (built-in hero,
-- texts and the feature pages) shows out of the box. Instances with a
-- published snapshot are left alone — their Home publish flag
-- (home_published) governs visibility there.
--
-- Idempotent — safe to re-run.
-- ============================================================================

UPDATE api.setting SET value = 'true'
WHERE key = 'SITE_LANDING_ENABLED'
  AND NOT EXISTS (SELECT 1 FROM api.site_published WHERE id = 1);
