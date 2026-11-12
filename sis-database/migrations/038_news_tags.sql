-- 038: tags on news posts (lowercase strings; filter pills on /news).
-- Idempotent.

ALTER TABLE api.news_post
  ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
