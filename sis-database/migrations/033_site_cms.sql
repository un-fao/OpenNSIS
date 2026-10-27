-- 033: public landing page content (issue #13, v1 as amended).
--
-- One draft (singleton row the admin edits) and immutable published
-- snapshots with exactly one current. Content is a JSONB document:
--   { logo_url, hero: {title:{lang:..}, subtitle:{..}, image},
--     about_md:{lang:..}, footer_md:{lang:..},
--     colors: {primary, secondary} }
-- Publishing renders about/footer Markdown server-side (sanitised) into
-- about_html/footer_html inside the snapshot, so the public page never
-- parses Markdown. The landing stays off until an admin enables it.
-- Idempotent.

CREATE TABLE IF NOT EXISTS api.site_draft (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS api.site_snapshot (
  snapshot_id serial PRIMARY KEY,
  content     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  is_current  boolean NOT NULL DEFAULT false
);

-- At most one current snapshot.
CREATE UNIQUE INDEX IF NOT EXISTS site_snapshot_one_current
  ON api.site_snapshot ((1)) WHERE is_current;

INSERT INTO api.setting (key, value)
VALUES ('SITE_LANDING_ENABLED', 'false')
ON CONFLICT (key) DO NOTHING;
