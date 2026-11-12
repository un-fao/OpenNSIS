-- 037: News — blog-style posts on the public website (/news).
--
-- Posts live outside the site draft/publish blob: each row is managed and
-- published on its own from the Website → News sub-tab. The header link's
-- visibility is a site-content flag (news_published), like Catalogue and
-- Statistics. Idempotent.

CREATE TABLE IF NOT EXISTS api.news_post (
  post_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        text NOT NULL,
  body_md      text NOT NULL DEFAULT '',
  body_html    text NOT NULL DEFAULT '',
  images       jsonb NOT NULL DEFAULT '[]'::jsonb,
  author       text NOT NULL DEFAULT '',
  published    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
