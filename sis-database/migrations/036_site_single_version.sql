-- 036: drop site versioning — one published copy instead of snapshots.
--
-- The Website tab keeps Draft -> Publish only; version history and rollback
-- were removed from the product. api.site_snapshot (append-only history,
-- one current) becomes api.site_published, a singleton holding the live
-- rendered content. The current snapshot's content is carried over.
-- Idempotent.

CREATE TABLE IF NOT EXISTS api.site_published (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content       jsonb NOT NULL,
  published_at  timestamptz NOT NULL DEFAULT now(),
  published_by  text
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'api' AND table_name = 'site_snapshot') THEN
    INSERT INTO api.site_published (id, content, published_at, published_by)
    SELECT 1, content, created_at, created_by
    FROM api.site_snapshot WHERE is_current
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE api.site_snapshot;
  END IF;
END $$;
